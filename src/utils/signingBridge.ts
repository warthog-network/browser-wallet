import {
  WarthogDeFiTransactionContext,
  type AnyTransactionContext,
  type LegacyTransactionJson,
  type TransactionJson,
} from "warthog-ts";
import type { ChainPublic } from "../workers/phraseSign";
import type { WarthogSignOp, WarthogSignRequest } from "../workers/warthogSign";
import type { PathType } from "./walletKeys";

export type { ChainPublic, WarthogSignOp, WarthogSignRequest };

type WorkerResponse = {
  requestId: number;
  ok: boolean;
  error?: string;
  [k: string]: unknown;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<
  number,
  { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }
>();

function readAutoLockMinutes(): number {
  if (typeof localStorage === "undefined") return 15;
  const minutes = Number(localStorage.getItem("warthogAutoLockMinutes"));
  return [1, 5, 15, 30, 60].includes(minutes) ? minutes : 15;
}
let autoLockMs = readAutoLockMinutes() * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleLockHandler: (() => void) | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/signingWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const waiter = pending.get(msg.requestId);
      if (!waiter) return;
      pending.delete(msg.requestId);
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new Error(msg.error || "Signing worker request failed"));
    };
    worker.onerror = (event) => {
      pending.forEach(({ reject }) => {
        reject(new Error(event.message || "Signing worker crashed"));
      });
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function callWorker(action: string, payload: Record<string, unknown> = {}) {
  const w = getWorker();
  return new Promise<WorkerResponse>((resolve, reject) => {
    const requestId = ++nextRequestId;
    pending.set(requestId, { resolve, reject });
    w.postMessage({ requestId, action, payload });
  });
}

export function getAutoLockMs() {
  return autoLockMs;
}

export function setAutoLockMinutes(minutes: number) {
  if (![1, 5, 15, 30, 60].includes(minutes)) return;
  localStorage.setItem("warthogAutoLockMinutes", String(minutes));
  autoLockMs = minutes * 60 * 1000;
  bumpIdleTimer();
}

export function setIdleLockHandler(fn: (() => void) | null) {
  idleLockHandler = fn;
}

export function bumpIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void lockSigningWorker();
    idleLockHandler?.();
  }, autoLockMs);
}

export async function unlockSigningWorker(data: {
  privateKey: string;
  publicKey?: string;
  address?: string;
  mnemonic?: string;
}) {
  const result = await callWorker("unlock", data);
  bumpIdleTimer();
  return result;
}

export async function lockSigningWorker() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!worker) return { unlocked: false };
  return callWorker("lock");
}

export async function getSigningStatus(): Promise<{
  unlocked: boolean;
  address: string | null;
  publicKey: string | null;
  hasMnemonic: boolean;
}> {
  if (!worker) {
    return { unlocked: false, address: null, publicKey: null, hasMnemonic: false };
  }
  const r = await callWorker("status");
  return {
    unlocked: Boolean(r.unlocked),
    address: (r.address as string) || null,
    publicKey: (r.publicKey as string) || null,
    hasMnemonic: Boolean(r.hasMnemonic),
  };
}

/** Explicit user export only (Show key / download / encrypted backup). */
export async function exportWalletFromWorker() {
  const r = await callWorker("exportWallet");
  return r.wallet as {
    privateKey: string;
    publicKey: string | null;
    address: string | null;
    mnemonic: string | null;
  };
}

export function warthogContextFields(
  ctx: AnyTransactionContext,
): Pick<WarthogSignRequest, "family" | "pinHash" | "pinHeight" | "nonceId" | "feeE8"> {
  return {
    family: ctx instanceof WarthogDeFiTransactionContext ? "defi" : "legacy",
    pinHash: ctx.chainPin.pinHash,
    pinHeight: ctx.chainPin.pinHeight,
    nonceId: ctx.nonceId.value,
    feeE8: ctx.fee.E8.toString(),
  };
}

function reviveWarthogTx(value: unknown): TransactionJson | LegacyTransactionJson {
  if (!value || typeof value !== "object") throw new Error("Could not sign the Warthog transaction.");
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item && typeof item === "object" && "$bigint" in item) {
      const raw = (item as { $bigint?: unknown }).$bigint;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        throw new Error("Could not sign the Warthog transaction.");
      }
      out[key] = BigInt(raw);
    } else {
      out[key] = item;
    }
  }
  if (typeof out.signature65 !== "string" || out.signature65.length === 0) {
    throw new Error("Could not sign the Warthog transaction.");
  }
  return out as TransactionJson;
}

/** Ask the worker to sign. The private key stays in the worker. */
export async function signWarthogInWorker(
  request: WarthogSignRequest,
  expectedAddress?: string,
): Promise<TransactionJson | LegacyTransactionJson> {
  // Always name the account on screen. The worker refuses to sign with a key
  // whose address differs, so a send can never go out from another account.
  if (!expectedAddress?.trim()) throw new Error("No account selected");
  const status = await getSigningStatus();
  if (!status.unlocked) throw new Error("Wallet is locked — unlock to sign");
  const result = await callWorker("signWarthog", {
    request,
    expectedAddress,
  });
  return reviveWarthogTx(result.tx);
}

export async function signPreparedWarthog(
  ctx: AnyTransactionContext,
  op: WarthogSignOp,
  expectedAddress?: string,
): Promise<TransactionJson | LegacyTransactionJson> {
  return signWarthogInWorker({ ...warthogContextFields(ctx), ...op }, expectedAddress);
}

/** Public ETH, Bitcoin, and Solana addresses for one account. Null when the worker has no phrase. */
export async function chainPublicFromWorker(index: number): Promise<ChainPublic | null> {
  const status = await getSigningStatus();
  if (!status.unlocked || !status.hasMnemonic) return null;
  const result = await callWorker("chainPublic", { index });
  return result.chains as ChainPublic;
}

/** Switch the active Warthog key inside the worker. The phrase stays there. */
export async function activateWorkerAccount(
  pathType: PathType,
  index: number,
): Promise<{ address: string; publicKey: string }> {
  const result = await callWorker("activateAccount", { pathType, index });
  const address = String(result.address || "");
  const publicKey = String(result.publicKey || "");
  if (!address || !publicKey) throw new Error("Could not switch accounts");
  return { address, publicKey };
}

export async function signEthereumInWorker(index: number, unsignedSerialized: string): Promise<string> {
  const result = await callWorker("signEthereum", { index, unsignedSerialized });
  const signature = String(result.signature || "");
  if (!signature) throw new Error("Could not sign the Ethereum transaction.");
  return signature;
}

export async function signSolanaInWorker(index: number, message: Uint8Array): Promise<Uint8Array> {
  const result = await callWorker("signSolana", { index, message });
  const signature = result.signature;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("Could not sign the Solana transaction.");
  }
  return signature;
}

export async function signBitcoinInWorker(
  index: number,
  psbt: Uint8Array,
): Promise<{ hex: string; txid: string }> {
  const result = await callWorker("signBitcoin", { index, psbt });
  const hex = String(result.hex || "");
  const txid = String(result.txid || "");
  if (!hex || !/^[0-9a-f]{64}$/i.test(txid)) throw new Error("Could not sign the Bitcoin transaction.");
  return { hex, txid };
}
