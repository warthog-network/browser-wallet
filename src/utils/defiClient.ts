/**
 * DeFi testnet helpers (wartbunker core functions) via warthog-ts.
 * Only used when the selected node is a DeFi/testnet node.
 */
import {
  Account,
  Address,
  Funds,
  Liquidity,
  NonceId,
  Price,
  RoundedFee,
  TokenDecimals,
  Wart,
  WarthogDeFiApi,
} from "warthog-ts";
import { DEFAULT_TX_FEE } from "../config/network";
import { normalizeNodeUrl } from "./nodes";
import { isEmptyAccountError, nodeRead } from "./warthogNode";
import { formatAmountFromRaw, formatBalanceBreakdown } from "./balanceBreakdown";
import { signPreparedWarthog, type WarthogSignOp } from "./signingBridge";
import { ensureHostPermission, hostPermissionError, privilegedFetch } from "./hostAccess";

/** Matches mobile-wallet AssetBalance / OpenOrders shapes. */
export type DefiAssetBalance = {
  hash: string;
  name: string;
  /** Total holdings (available + locked). Backward-compatible field. */
  balance: string;
  available: string;
  locked: string;
  hasLocked: boolean;
  decimals: number;
};

export type OpenLimitOrder = {
  txHash?: string;
  amount?: { str?: string };
  filled?: { str?: string };
  limit?: { doubleAdjusted?: number; hex?: string };
  formattedLimitPrice?: string;
  inMempool?: boolean;
};

export type OpenOrdersByAsset = {
  baseAsset: {
    hash?: string;
    id?: number;
    name?: string;
    decimals?: number;
  };
  wartToAssetSwaps?: OpenLimitOrder[];
  assetToWartSwaps?: OpenLimitOrder[];
};

export type LiquidityPosition = {
  hash: string;
  name: string;
  assetId?: number;
  decimals: number;
  lpBalance: string;
  poolWart: string;
  poolAsset: string;
};

export type AssetInfo = {
  hash?: string;
  assetHash?: string;
  id?: number;
  name?: string;
  decimals?: number;
};

export function createDefiApi(nodeBase: string): WarthogDeFiApi {
  const base = normalizeNodeUrl(nodeBase);
  if (!base) throw new Error("Invalid node URL");
  // The DeFi client speaks the V2 generation: /chain/head nests ChainHead
  // under `chainHead`, and a transfer carries its amount in `wartE8`.
  //
  // The transport is the wallet's privilegedFetch, so a plain-HTTP node is
  // still reachable from a full tab: the page fetch falls back to the
  // background worker.
  return new WarthogDeFiApi(base, { fetch: privilegedFetch });
}

export function accountFromPrivateKey(privateKeyHex: string): Account {
  const clean = privateKeyHex.replace(/^0x/i, "");
  return Account.fromPrivateKeyHex(clean);
}

function nonceStorageKey(address: string) {
  return `warthogNextNonce_${address.toLowerCase()}`;
}

export function getSmartNonce(address: string, fallback = 0): number {
  try {
    const stored = localStorage.getItem(nonceStorageKey(address));
    const n = stored ? Number(stored) : 0;
    return Math.max(n, fallback, 0);
  } catch {
    return fallback;
  }
}

export function bumpNonce(address: string, usedNonce: number): number {
  const next = Math.max(getSmartNonce(address), usedNonce + 1);
  try {
    localStorage.setItem(nonceStorageKey(address), String(next));
  } catch {
    // ignore
  }
  return next;
}

/**
 * Resolve fee the node will accept — prefer encode16bit (same as wartbunker /
 * mobile). Local ceil alone can disagree (e.g. 0.01 → 1000448 vs 999936).
 */
async function resolveFee(
  nodeBase: string,
  feeInput?: string,
): Promise<RoundedFee> {
  const feeStr =
    String(feeInput ?? DEFAULT_TX_FEE)
      .trim()
      .replace(",", ".") || DEFAULT_TX_FEE;

  // Node-authoritative compact fee (mainnet + DeFi shapes)
  try {
    const data = await nodeRead<{
      roundedE8?: number | string;
      rounded?: { E8?: number | string };
    }>(nodeBase, `tools/encode16bit/from_string/${encodeURIComponent(feeStr)}`);
    const rounded = data.roundedE8 ?? data.rounded?.E8;
    if (rounded != null) {
      // Already node-rounded — floor re-round is idempotent on compact values
      const fromNode = RoundedFee.fromE8(BigInt(rounded), false);
      if (fromNode) return fromNode;
    }
  } catch {
    // fall through to local rounding
  }

  const preferred = Wart.parse(feeStr)?.roundedFee(true);
  if (!preferred) throw new Error(`Invalid fee "${feeStr}"`);

  try {
    const feeRes = await nodeRead<{ minFee?: { E8?: number | string } }>(
      nodeBase,
      "transaction/minfee",
    );
    const minE8 = BigInt(feeRes?.minFee?.E8 ?? 0);
    if (preferred.E8 < minE8) {
      throw new Error(
        `Fee too low (min ${(Number(minE8) / 1e8).toFixed(8)} WART)`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Fee too")) throw e;
  }
  return preferred;
}

async function signAndSubmit(
  nodeBase: string,
  address: string,
  op: WarthogSignOp,
  opts?: { fee?: string; nonceId?: number },
): Promise<{ txHash: string; nonce: number }> {
  const api = createDefiApi(nodeBase);
  const fee = await resolveFee(nodeBase, opts?.fee);
  const nonceId = opts?.nonceId ?? getSmartNonce(address);
  const nonce = NonceId.fromNumber(nonceId);
  if (!nonce) throw new Error(`Invalid nonce ${nonceId}`);

  let ctx;
  try {
    ctx = await api.createTransactionContext(fee, nonce);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Non-JSON / gateway HTML is a common extension failure mode
    if (/JSON|Unexpected token|<!DOCTYPE|<html/i.test(msg)) {
      throw new Error(
        "Node returned a non-JSON response (gateway/offline). Try another DeFi node.",
      );
    }
    throw new Error(msg || "Failed to build transaction context (pin/fee)");
  }

  // warthog-ts serializes bigints to numbers inside request(), so no local
  // serializer is needed here. The worker signs and returns the transaction.
  const tx = await signPreparedWarthog(ctx, op, address);
  const submit = await api.submitTransaction(tx);
  if (!submit.success) {
    const err = submit.error || "Node rejected transaction";
    // Surface fee/nonce hints like wartbunker
    if (/fee/i.test(err)) {
      throw new Error(`${err} — check fee (default ${DEFAULT_TX_FEE} WART)`);
    }
    if (/nonce/i.test(err)) {
      throw new Error(
        `${err} — try again; nonce was ${nonceId}. Refresh balance if this persists.`,
      );
    }
    throw new Error(err);
  }
  const txHash =
    (submit.data as { txHash?: string })?.txHash ||
    (tx as { hash?: string }).hash ||
    "";
  bumpNonce(address, nonceId);
  return { txHash, nonce: nonceId };
}

export function normalizeAssetHash(raw: string): string {
  return raw.trim().replace(/^0x/i, "").toLowerCase();
}

export function isValidAssetHash(hash: string): boolean {
  const h = normalizeAssetHash(hash);
  return h.length === 64 && /^[0-9a-f]+$/.test(h);
}

function formatBalanceObj(obj: unknown, decimals = 8): string {
  if (obj == null) return "0";
  if (typeof obj === "object") {
    const o = obj as { str?: string; E8?: number | string; u64?: number | string };
    if (o.str) return o.str;
    if (o.E8 !== undefined) return formatAmountFromRaw(o.E8, 8);
    if (o.u64 !== undefined) return formatAmountFromRaw(o.u64, decimals);
  }
  if (typeof obj === "string" || typeof obj === "number") return String(obj);
  return "0";
}

/** Fetch asset balance for one hash (total / available / locked). */
export async function fetchAssetBalance(
  nodeBase: string,
  address: string,
  assetHash: string,
): Promise<DefiAssetBalance> {
  const hash = normalizeAssetHash(assetHash);
  // GET /account/:account/balance/:tokenspec
  const data = (await nodeRead<{
    token?: { name?: string; decimals?: number };
    balance?: unknown;
  }>(nodeBase, `account/${address}/balance/${hash}`)) ?? {};
  const tokenInfo = data?.token || {};
  const decimals = tokenInfo.decimals ?? 8;
  const breakdown = formatBalanceBreakdown(data?.balance, {
    kind: "token",
    decimals,
  });
  return {
    hash,
    name: tokenInfo.name || hash.slice(0, 8),
    balance: breakdown.total,
    available: breakdown.available,
    locked: breakdown.locked,
    hasLocked: breakdown.hasLocked,
    decimals,
  };
}

/** Search assets by name prefix. */
export async function searchAssets(
  nodeBase: string,
  namePrefix: string,
  hashPrefix?: string,
): Promise<unknown[]> {
  // GET /asset/complete?namePrefix=&hashPrefix=
  const params = new URLSearchParams({ namePrefix: namePrefix ?? "" });
  if (hashPrefix) params.set("hashPrefix", hashPrefix);
  const data = (await nodeRead<{ assets?: unknown[] } | unknown[]>(
    nodeBase,
    `asset/complete?${params.toString()}`,
  )) as { assets?: unknown[] } | unknown[];
  if (Array.isArray(data)) return data;
  return (data as { assets?: unknown[] })?.assets || [];
}

/**
 * Lookup a single asset by full 64-char hash.
 * Empty input is not valid for lookup — use searchAssetsDetailed("", …) to list all.
 */
export async function lookupAsset(
  nodeBase: string,
  assetHash: string,
): Promise<unknown> {
  const hash = normalizeAssetHash(assetHash);
  if (!hash) {
    throw new Error("Enter a 64-character asset hash, or use Search with empty fields to list all");
  }
  if (!isValidAssetHash(hash)) {
    throw new Error("Asset hash must be exactly 64 hex characters");
  }
  // GET /asset/lookup/:asset — never call the bare /asset/lookup/ form, which
  // nginx answers with an HTML 502.
  return nodeRead<unknown>(nodeBase, `asset/lookup/${hash}`);
}

/** DEX market info. */
export async function getDexMarket(
  nodeBase: string,
  assetHash: string,
): Promise<unknown> {
  // GET /dex/market/:asset
  return nodeRead<unknown>(
    nodeBase,
    `dex/market/${normalizeAssetHash(assetHash)}`,
  );
}

/** Open limit orders for account (mobile-wallet OpenOrdersByAsset[] shape). */
export async function getOpenOrders(
  nodeBase: string,
  address: string,
): Promise<OpenOrdersByAsset[]> {
  // GET /account/:account/open_orders
  let data: unknown[];
  try {
    data = await nodeRead<unknown[]>(nodeBase, `account/${address}/open_orders`);
  } catch (error) {
    if (isEmptyAccountError(error)) return [];
    throw error;
  }
  if (!Array.isArray(data)) return [];
  return data as OpenOrdersByAsset[];
}

/**
 * Search assets — empty name + empty hash lists all (node /asset/complete).
 * Bypasses the SDK for empty search so we control the query string and HTML errors.
 */
export async function searchAssetsDetailed(
  nodeBase: string,
  namePrefix = "",
  hashPrefix?: string,
): Promise<{ matches: AssetInfo[] }> {
  const base = normalizeNodeUrl(nodeBase);
  if (!base) throw new Error("Invalid node URL");

  const params = new URLSearchParams();
  // Always send namePrefix (empty = list all on defi testnet)
  params.set("namePrefix", namePrefix.trim());
  if (hashPrefix?.trim()) {
    params.set("hashPrefix", hashPrefix.trim().replace(/^0x/i, "").toLowerCase());
  }

  const url = `${base}/asset/complete?${params.toString()}`;
  if (!(await ensureHostPermission(base))) {
    throw new Error(hostPermissionError(base));
  }
  let text: string;
  try {
    const response = await privilegedFetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    text = await response.text();
  } catch (e) {
    throw new Error(
      e instanceof Error ? e.message : "Network error fetching assets",
    );
  }

  if (text.trimStart().startsWith("<")) {
    throw new Error(
      "Node returned HTML instead of JSON (bad path or gateway error). Try another DeFi node.",
    );
  }

  let json: { code?: number; data?: unknown; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from asset search");
  }

  if (json.code !== 0) {
    throw new Error(json.error || `Asset search error code ${json.code}`);
  }

  const data = json.data as { matches?: AssetInfo[] } | AssetInfo[] | undefined;
  if (Array.isArray(data)) return { matches: data };
  return { matches: data?.matches ?? [] };
}

function parseDisplayAmount(v: unknown, fallback = "0"): string {
  if (v == null) return fallback;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as { str?: string; E8?: number | string; u64?: number | string };
    if (o.str) return o.str;
    if (o.E8 !== undefined) return formatAmountFromRaw(o.E8, 8);
    if (o.u64 !== undefined) return formatAmountFromRaw(o.u64, 8);
  }
  return fallback;
}

export function computePoolSpotPrice(marketData: Record<string, unknown>): number | null {
  const pool = (marketData.liquidityPool || marketData.liquidity) as
    | Record<string, unknown>
    | undefined;
  if (!pool) return null;
  const wart = parseFloat(parseDisplayAmount(pool.wart || pool.WART, "0"));
  const asset = parseFloat(parseDisplayAmount(pool.asset, "0"));
  if (!Number.isFinite(wart) || !Number.isFinite(asset) || asset <= 0) return null;
  return wart / asset;
}

export async function fetchLiquidityBalance(
  nodeBase: string,
  address: string,
  assetHash: string,
): Promise<{ balance: string; name: string; decimals: number } | null> {
  const hash = normalizeAssetHash(assetHash);
  // GET /account/:account/balance/liquidity:<asset>
  let data: {
    token?: { name?: string; decimals?: number };
    asset?: { name?: string; decimals?: number };
    balance?: { total?: unknown } | unknown;
  };
  try {
    data = await nodeRead(nodeBase, `account/${address}/balance/liquidity:${hash}`);
  } catch {
    return null;
  }
  if (!data) return null;
  const balanceInfo =
    (data.balance as { total?: unknown })?.total || data.balance || data;
  const tokenInfo = data.token || data.asset || {};
  const decimals = Number(tokenInfo.decimals ?? 8);
  const balStr = formatBalanceObj(balanceInfo, decimals);
  if (!balStr || balStr === "0" || parseFloat(balStr) <= 0) return null;
  return {
    balance: balStr,
    name: String(tokenInfo.name || "Asset"),
    decimals,
  };
}

export async function fetchLiquidityPositions(
  nodeBase: string,
  address: string,
  assetHashes: string[],
  knownAssets: DefiAssetBalance[] = [],
): Promise<LiquidityPosition[]> {
  const unique = [...new Set(assetHashes.map(normalizeAssetHash))];
  const positions = await Promise.all(
    unique.map(async (hash) => {
      try {
        const [lp, market] = await Promise.all([
          fetchLiquidityBalance(nodeBase, address, hash),
          getDexMarket(nodeBase, hash).catch(() => null),
        ]);
        if (!lp) return null;
        const m = market as Record<string, unknown> | null;
        const base = (m?.baseAsset || m?.asset || {}) as Record<string, unknown>;
        const pool = (m?.liquidityPool || m?.liquidity || {}) as Record<
          string,
          unknown
        >;
        const known = knownAssets.find(
          (a) => a.hash.toLowerCase() === hash,
        );
        return {
          hash,
          name: String(base.name || lp.name || known?.name || "Asset"),
          assetId: base.id != null ? Number(base.id) : undefined,
          decimals: lp.decimals,
          lpBalance: lp.balance,
          poolWart: parseDisplayAmount(pool.wart || pool.WART),
          poolAsset: parseDisplayAmount(pool.asset),
        } as LiquidityPosition;
      } catch {
        return null;
      }
    }),
  );
  return positions.filter((p): p is LiquidityPosition => p != null);
}

/** Fake-mine a block to the given address (testnet/debug only). */
export async function fakeMine(
  nodeBase: string,
  address: string,
): Promise<unknown> {
  // Testnet-only debug helper; POSTs to the node's fake-mine hook.
  const base = normalizeNodeUrl(nodeBase);
  if (!base) throw new Error("Invalid node URL");
  const response = await privilegedFetch(`${base}/fake_mine/${address}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  if (!response.ok) throw new Error(`Fake mine failed (HTTP ${response.status})`);
  const json = (await response.json()) as { code?: number; data?: unknown; error?: string };
  if (json.code !== 0) throw new Error(json.error || "Fake mine failed");
  return json.data;
}

/**
 * Encode a human limit price to the 6-char hex the node expects.
 *
 * `decimals` is the **asset's** decimal count, which is what Price's
 * fromNumberDecimals needs in order to convert a human price into the
 * normalized mantissa/exponent pair. Rounding matters: a buy rounds up and a
 * sell rounds down, so the price the user typed is always the price that gets
 * honoured.
 */
export function encodeLimitPriceHex(
  priceStr: string,
  decimals = 8,
  ceil = false,
): string {
  const text = String(priceStr).trim();
  const value = parseFloat(text.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Could not encode limit price");
  }
  const clamped = Math.min(Math.max(decimals, 0), 18);
  const price = Price.fromNumberDecimals(
    value,
    new TokenDecimals(clamped),
    ceil,
  );
  if (!price) {
    // A price below the representable range floors to zero. Retry rounding up
    // before giving up, mirroring the previous encoder's fallback.
    if (!ceil) {
      const roundedUp = Price.fromNumberDecimals(
        value,
        new TokenDecimals(clamped),
        true,
      );
      if (roundedUp) return roundedUp.toHex();
    }
    throw new Error("Could not encode limit price");
  }
  return price.toHex();
}

export async function createAssetTx(
  nodeBase: string,
  address: string,
  params: { name: string; supply: string; decimals: number; fee?: string },
) {
  const assetName = params.name.trim().toUpperCase();
  if (!assetName || assetName.length > 5) {
    throw new Error("Asset name must be 1–5 characters");
  }
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 18) {
    throw new Error("Decimals must be a whole number from 0 to 18");
  }
  const precisionValue = Math.min(Math.max(params.decimals, 0), 18);
  const precision = new TokenDecimals(precisionValue);
  const totalSupply = Funds.parse(
    String(params.supply).trim().replace(",", "."),
    precision,
  );
  if (!totalSupply) throw new Error("Invalid total supply");

  return signAndSubmit(nodeBase, address, {
    op: "assetCreation",
    supplyU64: totalSupply.amount.toString(),
    decimals: precision.decimals,
    name: assetName,
  }, { fee: params.fee });
}

export async function transferAssetTx(
  nodeBase: string,
  address: string,
  params: {
    assetHash: string;
    toAddress: string;
    amount: string;
    decimals: number;
    isLiquidity?: boolean;
    fee?: string;
  },
) {
  const hash = normalizeAssetHash(params.assetHash);
  if (!isValidAssetHash(hash)) throw new Error("Invalid asset hash");
  const cleanTo = params.toAddress.trim().replace(/^0x/i, "").toLowerCase();
  const recipient =
    cleanTo.length === 48
      ? Address.fromHex(cleanTo)
      : Address.fromRaw(cleanTo);
  if (!recipient) throw new Error("Invalid recipient address");

  const amountStr = String(params.amount).trim().replace(",", ".");
  let op: WarthogSignOp;
  if (params.isLiquidity) {
    const units = Liquidity.parse(amountStr);
    if (!units) throw new Error("Invalid liquidity amount");
    op = {
      op: "tokenTransfer",
      assetHash: hash,
      isLiquidity: true,
      toAddr: recipient.hex,
      amountU64: units.E8.toString(),
    };
  } else {
    const precision = new TokenDecimals(
      Math.min(Math.max(params.decimals || 8, 0), 18),
    );
    const tokenAmount = Funds.parse(amountStr, precision);
    if (!tokenAmount) throw new Error("Invalid token amount");
    op = {
      op: "tokenTransfer",
      assetHash: hash,
      isLiquidity: false,
      toAddr: recipient.hex,
      amountU64: tokenAmount.amount.toString(),
    };
  }
  return signAndSubmit(nodeBase, address, op, { fee: params.fee });
}

export async function limitSwapTx(
  nodeBase: string,
  address: string,
  params: {
    assetHash: string;
    isBuy: boolean;
    amount: string;
    assetDecimals: number;
    limitPrice: string;
    fee?: string;
  },
) {
  const hash = normalizeAssetHash(params.assetHash);
  if (!isValidAssetHash(hash)) throw new Error("Invalid asset hash");
  // Prefer pre-encoded 6-char hex (SwapDex encodes with buy=ceil). Re-encode with
  // the same ceil rule as wartbunker if a human price string is passed.
  const limitHex =
    params.limitPrice.length === 6 && /^[0-9a-f]+$/i.test(params.limitPrice)
      ? params.limitPrice.toLowerCase()
      : encodeLimitPriceHex(
          params.limitPrice,
          params.assetDecimals,
          params.isBuy,
        );
  const limit = Price.fromHex(limitHex);
  if (!limit) throw new Error("Invalid limit price encoding");
  const amountStr = String(params.amount).trim().replace(",", ".");
  let amountU64: string;
  if (params.isBuy) {
    const wartAmount = Wart.parse(amountStr);
    if (!wartAmount) throw new Error("Invalid WART amount");
    amountU64 = wartAmount.E8.toString();
  } else {
    const precision = new TokenDecimals(
      Math.min(Math.max(params.assetDecimals || 8, 0), 18),
    );
    const tokenAmount = Funds.parse(amountStr, precision);
    if (!tokenAmount) throw new Error("Invalid token amount");
    amountU64 = tokenAmount.amount.toString();
  }

  return signAndSubmit(nodeBase, address, {
    op: "limitSwap",
    assetHash: hash,
    isBuy: params.isBuy,
    amountU64,
    limitHex: limit.toHex(),
  }, { fee: params.fee });
}

export async function depositLiquidityTx(
  nodeBase: string,
  address: string,
  params: {
    assetHash: string;
    assetAmount: string;
    wartAmount: string;
    decimals: number;
    fee?: string;
  },
) {
  const hash = normalizeAssetHash(params.assetHash);
  if (!isValidAssetHash(hash)) throw new Error("Invalid asset hash");
  const precision = new TokenDecimals(
    Math.min(Math.max(params.decimals || 8, 0), 18),
  );
  const tokenAmount = Funds.parse(
    String(params.assetAmount).trim().replace(",", "."),
    precision,
  );
  if (!tokenAmount) throw new Error("Invalid asset amount");
  const wart = Wart.parse(String(params.wartAmount).trim().replace(",", "."));
  if (!wart) throw new Error("Invalid WART amount");

  return signAndSubmit(nodeBase, address, {
    op: "liquidityDeposit",
    assetHash: hash,
    amountU64: tokenAmount.amount.toString(),
    wartE8: wart.E8.toString(),
  }, { fee: params.fee });
}

export async function withdrawLiquidityTx(
  nodeBase: string,
  address: string,
  params: { assetHash: string; shares: string; fee?: string },
) {
  const hash = normalizeAssetHash(params.assetHash);
  if (!isValidAssetHash(hash)) throw new Error("Invalid asset hash");
  const units = Liquidity.parse(
    String(params.shares).trim().replace(",", "."),
  );
  if (!units) throw new Error("Invalid LP shares amount");

  return signAndSubmit(nodeBase, address, {
    op: "liquidityWithdrawal",
    assetHash: hash,
    amountE8: units.E8.toString(),
  }, { fee: params.fee });
}

async function resolveOrderCancelTarget(
  nodeBase: string,
  txHash: string,
  accountAddress: string,
): Promise<{ cancelHeight: number; cancelNonceId: number }> {
  const normalized = txHash.trim().toLowerCase();
  let lookupError: string | undefined;
  try {
    // GET /transaction/lookup/:txid
    const lookup = await nodeRead<{
      transaction?: { signedCommon?: { pinHeight?: number; nonceId?: number } };
    }>(nodeBase, `transaction/lookup/${normalized}`);
    const signedCommon = lookup?.transaction?.signedCommon;
    if (signedCommon?.pinHeight != null && signedCommon?.nonceId != null) {
      return {
        cancelHeight: Number(signedCommon.pinHeight),
        cancelNonceId: Number(signedCommon.nonceId),
      };
    }
  } catch (e) {
    lookupError = e instanceof Error ? e.message : String(e);
  }

  // Fall back to the mempool: a not-yet-mined order has no on-chain record.
  try {
    // GET /account/:account/mempool
    const mem = await nodeRead<
      {
        transaction?: {
          hash?: string;
          signedCommon?: { pinHeight?: number; nonceId?: number };
        };
      }[]
    >(nodeBase, `account/${accountAddress}/mempool`);
    if (Array.isArray(mem)) {
      for (const entry of mem) {
        if (entry?.transaction?.hash?.toLowerCase() !== normalized) continue;
        const sc = entry.transaction.signedCommon;
        if (sc?.pinHeight != null && sc?.nonceId != null) {
          return {
            cancelHeight: Number(sc.pinHeight),
            cancelNonceId: Number(sc.nonceId),
          };
        }
      }
    }
  } catch {
    // fall through to the shared error below
  }

  throw new Error(
    lookupError || "Could not resolve order details for cancel",
  );
}

export async function cancelOrderTx(
  nodeBase: string,
  address: string,
  params: { orderTxHash: string; fee?: string },
) {
  const target = await resolveOrderCancelTarget(
    nodeBase,
    params.orderTxHash,
    address,
  );
  return cancelOrderTargetTx(nodeBase, address, { ...target, fee: params.fee });
}

export async function cancelOrderTargetTx(
  nodeBase: string,
  address: string,
  params: { cancelHeight: number; cancelNonceId: number; fee?: string },
) {
  const target = params;
  const cancelNonce = NonceId.fromNumber(target.cancelNonceId);
  if (!cancelNonce) {
    throw new Error(`Invalid cancel nonce ${target.cancelNonceId}`);
  }

  return signAndSubmit(nodeBase, address, {
    op: "cancelation",
    cancelHeight: target.cancelHeight,
    cancelNonceId: target.cancelNonceId,
  }, { fee: params.fee });
}

/** Parse open-order entries into a flat list for the UI. */
export function flattenOpenOrders(raw: unknown[]): {
  txHash: string;
  assetHash: string;
  side: string;
  amount: string;
  price: string;
}[] {
  const out: {
    txHash: string;
    assetHash: string;
    side: string;
    amount: string;
    price: string;
  }[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    // Common shapes: { txHash, assetHash, isBuy, amount, limit } or nested transaction
    const tx = (e.transaction as Record<string, unknown>) || e;
    const data = (tx.data as Record<string, unknown>) || e;
    const hash =
      String(e.txHash || tx.hash || e.hash || "").toLowerCase() || "";
    const assetHash = String(
      e.assetHash || data.assetHash || data.asset || "",
    ).toLowerCase();
    const isBuy =
      e.isBuy === true ||
      data.isBuy === true ||
      data.buy === true ||
      String(e.side || data.side || "").toLowerCase() === "buy";
    const amount = formatBalanceObj(
      data.amount ?? e.amount ?? data.amountU64 ?? e.amountU64,
    );
    const price =
      (data.limit as { doubleAdjusted?: number; hex?: string })?.doubleAdjusted !=
      null
        ? String((data.limit as { doubleAdjusted: number }).doubleAdjusted)
        : String(
            (data.limit as { hex?: string })?.hex ||
              data.limit ||
              e.limit ||
              "—",
          );

    if (hash) {
      out.push({
        txHash: hash,
        assetHash: assetHash || "—",
        side: isBuy ? "BUY" : "SELL",
        amount,
        price,
      });
    }
  }
  return out;
}
