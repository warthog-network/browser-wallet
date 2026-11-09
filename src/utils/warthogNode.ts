/**
 * Node API helpers aligned with website webwallet + wartbunker DeFi testnet.
 * Uses direct fetch (extension has host_permissions) — no proxy required.
 */
import { ethers } from "ethers";
import { DEFAULT_TX_FEE, type WalletNode } from "../config/network";
import { isDefiNode, normalizeNodeUrl } from "./nodes";
import { formatAmountFromRaw, formatBalanceBreakdown } from "./balanceBreakdown";
import { ensureHostPermission, hostPermissionError, privilegedFetch } from "./hostAccess";
import { NodeVersion, WarthogDeFiApi, WarthogLegacyApi } from "warthog-ts";

/**
 * How long a node has to answer before the read gives up.
 *
 * A node that accepts the connection and then goes quiet never settles,
 * and the card would wait on it forever. The read gives up instead and
 * reports it, so the user sees the error and can pick another node.
 */
export const NODE_READ_TIMEOUT_MS = 10_000;

export type BalanceResult = {
  /** Total holdings (available + locked). Kept for backward compatibility. */
  balance: string;
  /** Free to spend (total − locked − mempool). */
  available: string;
  /** Locked in open orders / pending. */
  locked: string;
  hasLocked: boolean;
  nextNonce: number;
  pinHeight: number;
  pinHash: string;
  network: "mainnet" | "defi-testnet";
};

type NodeJson<T = unknown> = {
  code: number;
  data?: T;
  error?: string;
};

async function nodeGet<T = unknown>(
  nodeBase: string,
  path: string,
): Promise<T> {
  const base = normalizeNodeUrl(nodeBase);
  if (!base) throw new Error("Invalid node URL");
  if (!(await ensureHostPermission(base))) {
    throw new Error(hostPermissionError(base));
  }
  const url = `${base}/${path.replace(/^\//, "")}`;
  const response = await privilegedFetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Node HTTP ${response.status}`);
  }
  const json = (await response.json()) as NodeJson<T>;
  if (json.code !== 0) {
    throw new Error(json.error || `Node error code ${json.code}`);
  }
  return json.data as T;
}

/**
 * A fresh account has no row on the node yet. History answers "Not found",
 * and the DeFi node answers "Address not found" for mempool and open orders.
 */
export function isEmptyAccountError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^(address )?not found$/.test(message.trim().toLowerCase());
}


/** Mainnet returns flat pin fields; DeFi may nest under chainHead */
function normalizeChainPin(data: Record<string, unknown>): {
  pinHash: string;
  pinHeight: number;
} {
  const nested =
    data.chainHead && typeof data.chainHead === "object"
      ? (data.chainHead as Record<string, unknown>)
      : null;
  const pinHash = String(nested?.pinHash ?? data.pinHash ?? "");
  const pinHeight = Number(
    nested?.pinHeight ?? nested?.height ?? data.pinHeight ?? data.height,
  );
  if (!pinHash || pinHash.length < 64 || !Number.isFinite(pinHeight)) {
    throw new Error("Invalid chain head: missing pinHash/pinHeight");
  }
  return { pinHash, pinHeight };
}

/** Parse a recipient address (40-char raw or 48-char checksummed). */
export function parseRecipientAddress(raw: string): string {
  const clean = String(raw || "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();
  if (!clean) {
    throw new Error("Please enter a recipient address");
  }
  if (!/^[0-9a-f]+$/.test(clean)) {
    throw new Error("Address must be hex");
  }
  if (clean.length === 48) {
    const payload = clean.slice(0, 40);
    const checksum = clean.slice(40);
    const expected = ethers.sha256("0x" + payload).slice(2, 10);
    if (checksum !== expected) {
      throw new Error("Invalid address checksum");
    }
    return clean;
  }
  if (clean.length === 40) {
    const checksum = ethers.sha256("0x" + clean).slice(2, 10);
    return clean + checksum;
  }
  throw new Error("Address must be 40 or 48 hex characters");
}

export function validateWarthogAddress(raw: string): boolean {
  try {
    parseRecipientAddress(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a read with a ceiling on how long it may take.
 *
 * The timeout is on the whole read, not on each request inside it, because
 * the balance read makes several requests one after another and a ceiling
 * on each would multiply out. The request itself is not aborted: the
 * caller stops waiting on it, and it finishes or fails on its own.
 */
async function withTimeout<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Node did not answer within ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetch WART balance + chain pin (mainnet `/balance` vs DeFi `/wart_balance`).
 * Returns total / available / locked so UIs can show free vs open-order locks.
 */
export function fetchBalanceAndPin(
  node: WalletNode,
  address: string,
): Promise<BalanceResult> {
  return withTimeout(
    fetchBalanceAndPinInner(node, address),
    NODE_READ_TIMEOUT_MS,
  );
}

async function fetchBalanceAndPinInner(
  node: WalletNode,
  address: string,
): Promise<BalanceResult> {
  const nodeBase = node.url;
  const defi = isDefiNode(node);
  const headData = await nodeGet<Record<string, unknown>>(nodeBase, "chain/head");
  const { pinHash, pinHeight } = normalizeChainPin(headData);

  let container: unknown = null;
  let nextNonce = 0;

  if (defi) {
    const data = await nodeGet<{
      wart?: unknown;
      balance?: unknown;
      account?: { nonceId?: number };
    }>(nodeBase, `account/${address}/wart_balance`);
    container = data?.wart ?? data?.balance;
    nextNonce = Number(data?.account?.nonceId) || 0;
  } else {
    try {
      const data = await nodeGet<Record<string, unknown>>(
        nodeBase,
        `account/${address}/balance`,
      );
      container = data?.balance;
      if (container == null && (data as { balanceE8?: unknown }).balanceE8 != null) {
        container = { E8: (data as { balanceE8: unknown }).balanceE8 };
      } else if (typeof container === "number" || typeof container === "string") {
        const n = parseFloat(String(container));
        if (Number.isFinite(n)) {
          container = {
            str: String(container),
            E8: Math.round(n * 1e8),
          };
        }
      }
      nextNonce =
        Number(data?.nonceId) ||
        Number((data as { nextNonce?: number })?.nextNonce) ||
        0;
    } catch {
      // Fallback for hybrid nodes
      const data = await nodeGet<{ wart?: unknown }>(
        nodeBase,
        `account/${address}/wart_balance`,
      );
      container = data?.wart;
      nextNonce = 0;
    }
  }

  const breakdown = formatBalanceBreakdown(container, { kind: "wart" });

  return {
    balance: breakdown.total,
    available: breakdown.available,
    locked: breakdown.locked,
    hasLocked: breakdown.hasLocked,
    nextNonce: Number.isFinite(nextNonce) ? nextNonce : 0,
    pinHeight,
    pinHash,
    network: defi ? "defi-testnet" : "mainnet",
  };
}

function formatFeeE8(e8: bigint | number | string): string {
  try {
    const n = Number(e8) / 1e8;
    return Number.isFinite(n) ? n.toFixed(8).replace(/\.?0+$/, "") : DEFAULT_TX_FEE;
  } catch {
    return DEFAULT_TX_FEE;
  }
}

/** Round fee via node encode16bit helper (accepted compact fee). */
async function roundFeeE8(nodeBase: string, feeWart: string): Promise<bigint> {
  try {
    const data = await nodeGet<{ roundedE8?: number | string }>(
      nodeBase,
      `tools/encode16bit/from_string/${encodeURIComponent(feeWart)}`,
    );
    if (data?.roundedE8 != null) return BigInt(data.roundedE8);
  } catch {
    // fall through
  }
  // Local approximate: parse to E8
  const n = Number(feeWart);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid fee "${feeWart}"`);
  }
  return BigInt(Math.round(n * 1e8));
}

/** Effective fee: max(preferred DEFAULT_TX_FEE, node minimum). */
export async function computeSuggestedTxFee(nodeBase: string): Promise<string> {
  try {
    const data = await nodeGet<{ minFee?: { E8?: number | string; str?: string } }>(
      nodeBase,
      "transaction/minfee",
    );
    const minFee = data?.minFee;
    if (minFee?.E8 == null) return DEFAULT_TX_FEE;

    const preferredE8 = await roundFeeE8(nodeBase, DEFAULT_TX_FEE);
    const minE8 = BigInt(minFee.E8);
    if (preferredE8 >= minE8) {
      return formatFeeE8(preferredE8);
    }
    return minFee.str || formatFeeE8(minE8);
  } catch {
    return DEFAULT_TX_FEE;
  }
}

export type SendWartParams = {
  nodeBase: string;
  /** Private key hex (64 chars, no 0x) */
  privateKeyHex: string;
  toAddress: string;
  amountWart: string | number;
  feeWart?: string;
  nonceId?: number;
};

export type SendWartResult = {
  txHash: string;
  feeE8: string;
  amountE8: string;
  nonceId: number;
  pinHeight: number;
};


export type HistoryItem = {
  date: string;
  action: string;
  amount: string;
  /** Raw amount without sign / unit (for mobile-style cards). */
  amountRaw?: string;
  usdAmount: string;
  txHash?: string;
  direction?: "in" | "out" | "self" | "unknown";
  type?: string;
  fromAddress?: string;
  toAddress?: string;
  height?: number;
  confirmations?: number;
  timestamp?: number | null;
  isReward?: boolean;
  isIncoming?: boolean;
  asset?: string;
  description?: string;
  fee?: string;
  source?: "indexer" | "node";
  meta?: Record<string, unknown> | null;
  assetName?: string | null;
  assetHash?: string | null;
  assetDecimals?: number | null;
  amountSecondary?: string | null;
  side?: string;
  orderAmount?: string;
  limitPrice?: string;
  baseAmount?: string;
  quoteAmount?: string;
  swapCount?: number;
};

export type HistoryFetchResult = {
  items: HistoryItem[];
  hasMore: boolean;
  nextPage?: number;
  source: "indexer" | "node";
  fromId?: number | null;
};

function getAmountStr(v: unknown, fallback = "0"): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v.trim() || fallback;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : fallback;
  if (typeof v === "object") {
    const obj = v as { str?: string; E8?: number | string };
    if (obj.str) return obj.str;
    if (obj.E8 !== undefined) return formatAmountFromRaw(obj.E8, 8);
  }
  return fallback;
}

type FlatTx = {
  amount: string;
  toAddress?: string;
  fromAddress?: string;
  txHash?: string;
  isReward?: boolean;
  height?: number;
  timestamp?: number | null;
  confirmations?: number;
  category?: string;
};

/**
 * Flatten node history `perBlock` pages (mainnet + DeFi shapes) into display rows.
 * Mirrors wartbunker `parseHistoryBlocks` / website webwallet activity.
 */
function flattenHistoryPage(rawData: Record<string, unknown>): FlatTx[] {
  const perBlock = rawData?.perBlock;
  if (!Array.isArray(perBlock)) return [];

  const items: FlatTx[] = [];

  const pushFlat = (entry: Record<string, unknown>, block: Record<string, unknown>, hint: string) => {
    // DeFi nested: { transaction: { data, hash, signedCommon }, historyId }
    const nested = (entry?.transaction as Record<string, unknown>) || entry;
    const data = (nested?.data as Record<string, unknown>) || entry;
    const common =
      (nested?.signedCommon as Record<string, unknown>) ||
      (nested?.signingData as Record<string, unknown>) ||
      {};

    const isReward =
      hint === "reward" ||
      Boolean(entry?.txHash && !entry?.fromAddress) ||
      Boolean(!common.originAddress && data.amount && !data.toAddress);

    const amountField =
      data.amount ?? entry.amount ?? entry.amountE8 ?? data.wart ?? data.wartE8;
    const amount = getAmountStr(amountField);

    const toAddress = String(
      data.toAddress || entry.toAddress || entry.toAddr || "",
    );
    const fromAddress = String(
      common.originAddress ||
        data.fromAddress ||
        entry.fromAddress ||
        entry.fromAddr ||
        "",
    );

    const header = block.header as { time?: { timestamp?: number; UTC?: string } } | undefined;
    const timestamp =
      header?.time?.timestamp ||
      Number(block.timestamp) ||
      null;

    items.push({
      amount,
      toAddress,
      fromAddress: fromAddress || undefined,
      txHash: String(
        nested.hash || entry.txHash || entry.hash || entry.txid || "",
      ),
      isReward,
      height: Number(block.height) || undefined,
      timestamp,
      confirmations: Number(block.confirmations) || undefined,
      category: hint,
    });
  };

  for (const block of perBlock as Record<string, unknown>[]) {
    const body =
      (block.body as Record<string, unknown>) ||
      (block.transactions as Record<string, unknown>) ||
      {};

    // Mainnet shape: transactions.rewards / transactions.transfers
    const rewards = (body.rewards ||
      (block.transactions as { rewards?: unknown[] })?.rewards) as
      | unknown[]
      | undefined;
    if (Array.isArray(rewards)) {
      rewards.forEach((r) =>
        pushFlat(r as Record<string, unknown>, block, "reward"),
      );
    }

    const transfers = (body.transfers ||
      (block.transactions as { transfers?: unknown[] })?.transfers) as
      | unknown[]
      | undefined;
    if (Array.isArray(transfers)) {
      transfers.forEach((t) =>
        pushFlat(t as Record<string, unknown>, block, "wartTransfer"),
      );
    }

    // DeFi single reward object
    if (body.reward) {
      const list = Array.isArray(body.reward) ? body.reward : [body.reward];
      list.forEach((r) =>
        pushFlat(r as Record<string, unknown>, block, "reward"),
      );
    }

    const defiKeys = [
      "wartTransfer",
      "tokenTransfer",
      "limitSwap",
      "liquidityDeposit",
      "liquidityWithdrawal",
      "assetCreation",
      "match",
      "cancelation",
    ];
    for (const key of defiKeys) {
      const arr = body[key];
      if (!Array.isArray(arr)) continue;
      const hint =
        key === "wartTransfer"
          ? "wartTransfer"
          : key === "tokenTransfer"
            ? "tokenTransfer"
            : key;
      arr.forEach((entry) =>
        pushFlat(entry as Record<string, unknown>, block, hint),
      );
    }
  }

  return items;
}

function toHistoryItem(tx: FlatTx, viewingAddress: string): HistoryItem {
  const account = viewingAddress.toLowerCase().replace(/^0x/i, "");
  const to = (tx.toAddress || "").toLowerCase();
  const from = (tx.fromAddress || "").toLowerCase();

  let direction: HistoryItem["direction"] = "unknown";
  if (tx.isReward) direction = "in";
  else if (from && from.startsWith(account.slice(0, 40)) && to.startsWith(account.slice(0, 40)))
    direction = "self";
  else if (from && from.startsWith(account.slice(0, 40))) direction = "out";
  else if (to && to.startsWith(account.slice(0, 40))) direction = "in";

  const ts = Number(tx.timestamp || 0);
  const date =
    ts > 0
      ? new Date(ts * (ts < 1e12 ? 1000 : 1)).toLocaleString()
      : tx.height
        ? `Block ${tx.height}`
        : "Unknown date";

  const signedAmount =
    direction === "out"
      ? `-${tx.amount}`
      : direction === "in"
        ? `+${tx.amount}`
        : tx.amount;

  const action = tx.isReward
    ? "Reward"
    : direction === "out"
      ? "Send WART"
      : direction === "in"
        ? "Receive WART"
        : tx.category || "Transfer";

  const isIncoming = direction === "in";
  const description = tx.isReward
    ? `Block reward ${tx.amount} WART`
    : direction === "out"
      ? `Sent ${tx.amount} WART`
      : direction === "in"
        ? `Received ${tx.amount} WART`
        : `${tx.category || "Transfer"} ${tx.amount} WART`;

  return {
    date,
    action,
    amount: `${signedAmount} WART`,
    amountRaw: tx.amount,
    usdAmount: "",
    txHash: tx.txHash,
    direction,
    type: tx.category || (tx.isReward ? "reward" : "wart_transfer"),
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    height: tx.height,
    confirmations: tx.confirmations,
    timestamp: tx.timestamp ?? null,
    isReward: Boolean(tx.isReward),
    isIncoming,
    asset: "WART",
    description,
  };
}

/**
 * Fetch a page of account history.
 * Prefers explorer indexer on DeFi (rich `meta` cards); falls back to node RPC.
 */
export async function fetchAccountHistory(
  node: WalletNode,
  address: string,
  options:
    | number
    | string
    | {
        beforeTxIndex?: number | string;
        page?: number;
        filter?: string;
      } = {},
): Promise<HistoryFetchResult> {
  const nodeBase = node.url;
  // Back-compat: third arg used to be beforeTxIndex only.
  const opts =
    typeof options === "object" && options !== null
      ? options
      : { beforeTxIndex: options as number | string };

  const beforeTxIndex = opts.beforeTxIndex ?? 4294967295;
  const page = Math.max(1, opts.page ?? 1);
  const filterId = opts.filter || "all";

  // Indexer path (DeFi testnet) — rich meta for limit swaps / matches / etc.
  try {
    const { fetchIndexerHistoryPage } = await import("./warthogIndexer");
    const indexed = await fetchIndexerHistoryPage(node, address, {
      page,
      filter: filterId,
    });
    if (indexed && indexed.items.length >= 0 && indexed.source === "indexer") {
      // Accept empty first page as success (account may truly have no txs of this filter).
      return {
        items: indexed.items as HistoryItem[],
        hasMore: indexed.hasMore,
        nextPage: indexed.nextPage,
        source: "indexer",
        fromId: null,
      };
    }
  } catch (err) {
    console.warn("[history] indexer path failed, falling back to node", err);
  }

  let data: Record<string, unknown>;
  try {
    data = await nodeGet<Record<string, unknown>>(
      nodeBase,
      `account/${address}/history/${beforeTxIndex}`,
    );
  } catch (error) {
    if (isEmptyAccountError(error)) {
      return {
        items: [],
        hasMore: false,
        fromId: null,
        source: "node",
      };
    }
    throw error;
  }

  const flat = flattenHistoryPage(data || {});
  const items = flat.map((tx) => {
    const item = toHistoryItem(tx, address);
    item.source = "node";
    return item;
  });
  const fromId =
    data && typeof (data as { fromId?: number }).fromId === "number"
      ? (data as { fromId: number }).fromId
      : null;

  return {
    items,
    hasMore: items.length > 0 && !!fromId && fromId > 0,
    fromId: fromId && fromId > 0 ? fromId : null,
    source: "node",
  };
}

/**
 * Health, latency and version check for a node.
 *
 * The version request is the liveness check: it is one request, it is
 * cheap, and it says what the node is as well as that it is up. The
 * account read stays, because a node on the wrong chain answers the
 * version request happily but has never heard of this wallet.
 *
 * The version comes from the SDK client, so it goes through the same
 * transport as everything else the wallet does: the privileged fetch that
 * falls back to the background worker. The path is the caller's business
 * because it differs per family, and the SDK picks it from the family.
 */
export async function probeNode(
  node: WalletNode,
  address?: string | null,
): Promise<{
  online: boolean;
  latencyMs: number;
  version: NodeVersion | null;
}> {
  const nodeBase = node.url;
  const start = performance.now();
  try {
    const api = isDefiNode(node)
      ? new WarthogDeFiApi(nodeBase, { fetch: privilegedFetch })
      : new WarthogLegacyApi(nodeBase, { fetch: privilegedFetch });
    const result = await api.getNodeVersion();
    if (!result.success) {
      return { online: false, latencyMs: performance.now() - start, version: null };
    }
    const version = result.data;
    if (address) {
      if (isDefiNode(node)) {
        await nodeGet(nodeBase, `account/${address}/wart_balance`);
      } else {
        try {
          await nodeGet(nodeBase, `account/${address}/balance`);
        } catch {
          // balance may 404 for empty accounts — the version is enough
        }
      }
    }
    return { online: true, latencyMs: performance.now() - start, version };
  } catch {
    return { online: false, latencyMs: performance.now() - start, version: null };
  }
}

/**
 * Read-only node GET.
 *
 * warthog-ts deliberately exposes only the transaction endpoints, so the
 * read-side calls (fee encoding, min fee, asset lookup, open orders, mempool)
 * go through this. It mirrors the SDK's envelope handling: HTTP non-2xx is an
 * error, and a payload with a non-zero `code` is an error too.
 */
export async function nodeRead<T = unknown>(
  nodeBase: string,
  path: string,
): Promise<T> {
  return withTimeout(nodeGet<T>(nodeBase, path), NODE_READ_TIMEOUT_MS);
}
