/**
 * Chrome closes the toolbar popup as soon as the passkey prompt takes focus.
 * Google Password Manager can still store the credential, but the popup is
 * already gone, so the wallet never writes the encrypted envelope.
 *
 * The toolbar panel stashes the job and opens a real window. That window
 * stays up through the prompt and finishes the save or unlock.
 */
import browser from "webextension-polyfill";
import type { EncryptedWalletPayload } from "./warthogWalletCrypto";
import { openStableExtensionWindow } from "./extensionNav";

const JOB_KEY = "warthogPasskeyHandoff";
const UNLOCK_KEY = "warthogToolbarUnlock";
const MAX_AGE_MS = 3 * 60 * 1000;
const UNLOCK_MAX_AGE_MS = 2 * 60 * 1000;

export class PasskeyHandedOff extends Error {
  constructor() {
    super("Passkey continues in a window");
    this.name = "PasskeyHandedOff";
  }
}

export function isPasskeyHandedOff(err: unknown): boolean {
  return err instanceof PasskeyHandedOff || (err instanceof Error && err.name === "PasskeyHandedOff");
}

/** True only for the toolbar dropdown. A windows.create popup is not this. */
export function isToolbarActionPopup(): boolean {
  try {
    // The ceremony window must never hand off again, even if Chrome reports
    // it as a popup view.
    if (
      typeof location !== "undefined" &&
      /passkey-host/.test(location.hash || "")
    ) {
      return false;
    }
    const chromeApi = (
      globalThis as {
        chrome?: {
          extension?: { getViews?: (opts: { type: string }) => Window[] };
        };
      }
    ).chrome;
    const views = chromeApi?.extension?.getViews?.({ type: "popup" });
    return Boolean(views && views.includes(window));
  } catch {
    return false;
  }
}

export type PasskeyJob =
  | {
      kind: "save";
      createdAt: number;
      name: string;
      password: string | null;
      require2fa: boolean;
      preferFingerprint: boolean;
      payload: EncryptedWalletPayload;
    }
  | {
      kind: "unlock";
      createdAt: number;
      name: string;
      password: string | null;
      encrypted: string;
    };

type SessionArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

/** `Omit` does not distribute over unions, so spell both job shapes. */
export type PasskeyJobInput =
  | Omit<Extract<PasskeyJob, { kind: "save" }>, "createdAt">
  | Omit<Extract<PasskeyJob, { kind: "unlock" }>, "createdAt">;

function jobStore(): SessionArea {
  // Session only. The save job holds the wallet key until the ceremony
  // finishes, and storage.local would keep that key on disk.
  const chromeSession = (
    globalThis as { chrome?: { storage?: { session?: SessionArea } } }
  ).chrome?.storage?.session;
  if (chromeSession) return chromeSession;
  const polyfillSession = (
    browser.storage as unknown as { session?: SessionArea }
  ).session;
  if (polyfillSession) return polyfillSession;
  throw new Error("Passkey setup needs extension session storage");
}

export async function storePasskeyJob(job: PasskeyJobInput): Promise<void> {
  await jobStore().set({ [JOB_KEY]: { ...job, createdAt: Date.now() } });
}

export async function readPasskeyJob(): Promise<PasskeyJob | null> {
  const stored = await jobStore().get(JOB_KEY);
  const job = stored?.[JOB_KEY] as PasskeyJob | undefined;
  if (!job || (job.kind !== "save" && job.kind !== "unlock")) return null;
  if (!job.createdAt || Date.now() - job.createdAt > MAX_AGE_MS) {
    await clearPasskeyJob();
    return null;
  }
  return job;
}

export async function clearPasskeyJob(): Promise<void> {
  try {
    await jobStore().remove(JOB_KEY);
  } catch {
    // ignore
  }
}

export async function openPasskeyCeremonyWindow(): Promise<void> {
  await openStableExtensionWindow("/passkey-host");
}

export type ToolbarUnlock = {
  createdAt: number;
  privateKey: string;
  publicKey: string;
  address: string;
  mnemonic?: string;
  pathType?: "hardened" | "non-hardened";
  password: string | null;
  name: string;
  savedWalletName?: string | null;
};

export async function storeToolbarUnlock(
  data: Omit<ToolbarUnlock, "createdAt">,
): Promise<void> {
  await jobStore().set({ [UNLOCK_KEY]: { ...data, createdAt: Date.now() } });
}

export async function readToolbarUnlock(): Promise<ToolbarUnlock | null> {
  const stored = await jobStore().get(UNLOCK_KEY);
  const data = stored?.[UNLOCK_KEY] as ToolbarUnlock | undefined;
  if (!data?.privateKey || !data.address) return null;
  if (!data.createdAt || Date.now() - data.createdAt > UNLOCK_MAX_AGE_MS) {
    await clearToolbarUnlock();
    return null;
  }
  return data;
}

export async function clearToolbarUnlock(): Promise<void> {
  try {
    await jobStore().remove(UNLOCK_KEY);
  } catch {
    // ignore
  }
}

/** Ask the service worker to open the toolbar dropdown after this window closes. */
export async function askBackgroundToReopenToolbar(
  windowId: number | undefined,
): Promise<void> {
  await browser.runtime.sendMessage({
    action: "reopenToolbarPopup",
    windowId,
  });
}

/** Stash the job, open the stable window, then close this toolbar panel. */
export async function handOffPasskeyJob(job: PasskeyJobInput): Promise<never> {
  await storePasskeyJob(job);
  try {
    await openPasskeyCeremonyWindow();
  } catch (err) {
    await clearPasskeyJob();
    throw err instanceof Error
      ? err
      : new Error("Could not open the passkey window");
  }
  try {
    window.close();
  } catch {
    // The panel may already be closing because the new window took focus.
  }
  throw new PasskeyHandedOff();
}
