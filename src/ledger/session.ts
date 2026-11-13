/**
 * Public Ledger data only. The device keeps the private key.
 *
 * The open session lets a connect or sign tab finish, and the toolbar popup
 * that opens immediately after a connect. Closing that dropdown ends it.
 * Saved names are bookmarks (name, address, path). They are not key files.
 */
import browser from "webextension-polyfill";
import type { PathType } from "../utils/walletKeys";
import { firefoxSidebarApi, hasDockedPanel } from "../utils/extensionNav";
import type { LedgerSession } from "./warthogApp";

const SESSION_KEY = "warthogLedgerSession";
const SIGN_KEY = "warthogLedgerSignJob";
const BOOKMARKS_KEY = "warthogLedgerBookmarks";
const HANDOFF_KEY = "warthogLedgerHandoff";
const ARM_KEY = "warthogLedgerPopupArm";
const WINDOW_KEY = "warthogLedgerWindow";
const LAST_TX_KEY = "warthogLedgerLastTx";
const PANEL_ROUTE_KEY = "warthogLedgerPanelRoute";
const SIGN_MAX_AGE_MS = 3 * 60 * 1000;
const HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;
const ARM_MAX_AGE_MS = 30 * 1000;

export type LedgerBookmark = {
  name: string;
  address: string;
  publicKey: string;
  pathType: PathType;
  index: number;
};

export type LedgerSignJob = {
  createdAt: number;
  pinHash: string;
  pinHeight: number;
  nonceId: number;
  feeE8: string;
  toAddress: string;
  amountE8: string;
  nodeIndex: number;
  /** Home handed this send off so the device tab can finish the dApp approval. */
  approveDapp?: boolean;
  approvalId?: string;
};

type SessionArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string | string[]) => Promise<void>;
};

function store(): SessionArea {
  const chromeSession = (
    globalThis as { chrome?: { storage?: { session?: SessionArea } } }
  ).chrome?.storage?.session;
  if (chromeSession) return chromeSession;
  const polyfillSession = (browser.storage as unknown as { session?: SessionArea }).session;
  if (polyfillSession) return polyfillSession;
  throw new Error("Ledger login needs extension session storage");
}

function isPath(value: unknown): value is PathType {
  return value === "hardened" || value === "non-hardened";
}

function isLedgerSession(value: unknown): value is LedgerSession {
  if (!value || typeof value !== "object") return false;
  const row = value as LedgerSession;
  return (
    typeof row.address === "string" &&
    row.address.length === 48 &&
    typeof row.publicKey === "string" &&
    row.publicKey.length === 130 &&
    isPath(row.pathType) &&
    typeof row.index === "number"
  );
}

export async function saveLedgerSession(session: LedgerSession): Promise<void> {
  // Memory session dies when the extension reloads. The public key is not a
  // secret, so a local copy lets the toolbar dropdown stay logged in.
  try {
    await store().set({ [SESSION_KEY]: session });
  } catch (err) {
    console.warn("[warthog] ledger session memory save failed", err);
  }
  await browser.storage.local.set({ [SESSION_KEY]: session });
}

export async function readLedgerSession(): Promise<LedgerSession | null> {
  try {
    const stored = await store().get(SESSION_KEY);
    const session = stored?.[SESSION_KEY];
    if (isLedgerSession(session)) return session;
  } catch {
    /* the local copy below still counts */
  }
  try {
    const local = await browser.storage.local.get(SESSION_KEY);
    const session = local?.[SESSION_KEY];
    return isLedgerSession(session) ? session : null;
  } catch {
    return null;
  }
}

export async function clearLedgerSession(): Promise<void> {
  try {
    await store().remove([SESSION_KEY, SIGN_KEY]);
  } catch {
    /* ignore */
  }
  try {
    await browser.storage.local.remove(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function storeLedgerSignJob(
  job: Omit<LedgerSignJob, "createdAt">,
): Promise<void> {
  await store().set({ [SIGN_KEY]: { ...job, createdAt: Date.now() } });
}

export async function readLedgerSignJob(): Promise<LedgerSignJob | null> {
  try {
    const stored = await store().get(SIGN_KEY);
    const job = stored?.[SIGN_KEY] as LedgerSignJob | undefined;
    if (!job?.toAddress || !job.pinHash || !job.createdAt) return null;
    if (Date.now() - job.createdAt > SIGN_MAX_AGE_MS) {
      await store().remove(SIGN_KEY);
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

export async function clearLedgerSignJob(): Promise<void> {
  try {
    await store().remove(SIGN_KEY);
  } catch {
    /* ignore */
  }
}

function isBookmark(value: unknown): value is LedgerBookmark {
  if (!value || typeof value !== "object") return false;
  const row = value as LedgerBookmark;
  return (
    typeof row.name === "string" &&
    row.name.trim().length > 0 &&
    typeof row.address === "string" &&
    row.address.length === 48 &&
    typeof row.publicKey === "string" &&
    row.publicKey.length === 130 &&
    isPath(row.pathType) &&
    typeof row.index === "number" &&
    row.index >= 0
  );
}

export async function listLedgerBookmarks(): Promise<LedgerBookmark[]> {
  try {
    const local = await browser.storage.local.get(BOOKMARKS_KEY);
    const raw = local?.[BOOKMARKS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isBookmark)
      .map((row) => ({ ...row, name: row.name.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Remember a Nano account under the name the user typed. */
export async function saveLedgerBookmark(bookmark: LedgerBookmark): Promise<void> {
  const name = bookmark.name.trim();
  if (!name) throw new Error("Wallet name is required");
  const next: LedgerBookmark = {
    name,
    address: bookmark.address,
    publicKey: bookmark.publicKey,
    pathType: bookmark.pathType,
    index: bookmark.index >>> 0,
  };
  if (!isBookmark(next)) throw new Error("Ledger bookmark is incomplete");
  const existing = await listLedgerBookmarks();
  const sameName = existing.find((row) => row.name === name);
  if (sameName && sameName.address.toLowerCase() !== next.address.toLowerCase()) {
    throw new Error("That name is already saved for a different Ledger account.");
  }
  const without = existing.filter((row) => row.name !== name);
  without.push(next);
  without.sort((a, b) => a.name.localeCompare(b.name));
  await browser.storage.local.set({ [BOOKMARKS_KEY]: without });
}

/** Change the login name for one Nano account. The address stays the same. */
export async function renameLedgerBookmark(fromName: string, toName: string): Promise<void> {
  const from = fromName.trim();
  const to = toName.trim();
  if (!from || !to || from === to) return;
  const existing = await listLedgerBookmarks();
  const current = existing.find((row) => row.name === from);
  if (!current) return;
  const clash = existing.find((row) => row.name === to);
  if (clash && clash.address.toLowerCase() !== current.address.toLowerCase()) {
    throw new Error("That name is already saved for a different Ledger account.");
  }
  const without = existing.filter((row) => row.name !== from && row.name !== to);
  without.push({ ...current, name: to });
  without.sort((a, b) => a.name.localeCompare(b.name));
  await browser.storage.local.set({ [BOOKMARKS_KEY]: without });
}

/** Same as save, but a name clash during logout must not block the lock. */
export async function rememberLedgerBookmark(bookmark: LedgerBookmark): Promise<void> {
  try {
    await saveLedgerBookmark(bookmark);
  } catch (err) {
    console.warn("[warthog] ledger name was not saved", err);
  }
}

/**
 * Set before the toolbar popup closes to open the Ledger tab. That close
 * must leave the session in place so the tab can still read it.
 */
export async function markLedgerHandoff(): Promise<void> {
  await store().set({ [HANDOFF_KEY]: Date.now() });
}

export async function consumeLedgerHandoff(): Promise<boolean> {
  try {
    const stored = await store().get(HANDOFF_KEY);
    const at = stored?.[HANDOFF_KEY];
    await store().remove(HANDOFF_KEY);
    return typeof at === "number" && Date.now() - at < HANDOFF_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export async function clearLedgerHandoff(): Promise<void> {
  try {
    await store().remove(HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}

/** True while a connect or sign tab still needs the stored session. */
export async function ledgerHandoffPending(): Promise<boolean> {
  try {
    const stored = await store().get(HANDOFF_KEY);
    const at = stored?.[HANDOFF_KEY];
    if (typeof at !== "number" || Date.now() - at >= HANDOFF_MAX_AGE_MS) {
      if (at != null) await store().remove(HANDOFF_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Lets the single popup opened right after connect restore this session. */
export async function armLedgerPopup(): Promise<void> {
  await store().set({ [ARM_KEY]: Date.now() });
}

export async function consumeLedgerPopupArm(): Promise<boolean> {
  try {
    const stored = await store().get(ARM_KEY);
    const at = stored?.[ARM_KEY];
    await store().remove(ARM_KEY);
    return typeof at === "number" && Date.now() - at < ARM_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Toolbar dropdown, or the docked side panel. Default is the dropdown. */
export type LedgerWindowMode = "dropdown" | "sidepanel";

export async function readLedgerWindowMode(): Promise<LedgerWindowMode> {
  // Firefox has one wallet view, the sidebar. A stored "dropdown" cannot bring
  // back a popup that the manifest no longer declares.
  if (firefoxSidebarApi()) return "sidepanel";
  try {
    const local = await browser.storage.local.get(WINDOW_KEY);
    const value = local?.[WINDOW_KEY];
    if (value !== "sidepanel" && value !== "tab") return "dropdown";
    // Only keep the docked mode where the wallet can dock.
    return hasDockedPanel() ? "sidepanel" : "dropdown";
  } catch {
    return "dropdown";
  }
}

type ChromeAction = {
  action?: { setPopup?: (details: { popup: string }) => Promise<void> | void };
  sidePanel?: {
    setPanelBehavior?: (details: { openPanelOnActionClick: boolean }) => Promise<void>;
    setOptions?: (details: { path?: string; enabled?: boolean }) => Promise<void>;
  };
};

/** Icon opens the dropdown, or the docked panel when that option is on. */
export async function applyLedgerWindowMode(mode: LedgerWindowMode): Promise<void> {
  if (firefoxSidebarApi()) {
    // Firefox: the toolbar icon and the sidebar are the same wallet view, so
    // the icon never opens a second copy in a popup.
    try {
      await maybePromise(
        (browser.action as unknown as IconAction).setPopup?.({ popup: "" }),
      );
    } catch (err) {
      console.warn("[warthog] could not clear the toolbar popup", err);
    }
    return;
  }
  const chromeApi = (globalThis as { chrome?: ChromeAction }).chrome;
  const sidePanel = chromeApi?.sidePanel;
  if (mode === "sidepanel") {
    // Only Chrome can hand the toolbar icon over to the docked panel. Firefox
    // keeps the dropdown and opens the sidebar when the Nano needs it, so the
    // popup must stay there.
    if (sidePanel) {
      await chromeApi?.action?.setPopup?.({ popup: "" });
      await sidePanel.setOptions?.({
        path: "index.html?sidepanel=1",
        enabled: true,
      });
      await sidePanel.setPanelBehavior?.({ openPanelOnActionClick: true });
    }
    return;
  }
  await sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
  await chromeApi?.action?.setPopup?.({ popup: "index.html" });
}

type IconAction = {
  setPopup?: (details: { popup: string }) => Promise<void> | void;
};

/** webextension-polyfill returns promises; raw chrome APIs may not. */
async function maybePromise(value: unknown): Promise<void> {
  if (value && typeof (value as Promise<void>).then === "function") {
    await value;
  }
}

export async function writeLedgerWindowMode(mode: LedgerWindowMode): Promise<void> {
  const next: LedgerWindowMode = mode === "sidepanel" ? "sidepanel" : "dropdown";
  await browser.storage.local.set({ [WINDOW_KEY]: next });
  await applyLedgerWindowMode(next);
}

/** Popup asks the side panel to open this hash route once. */
export async function setLedgerPanelRoute(route: string): Promise<void> {
  const clean = route.startsWith("/") ? route : `/${route}`;
  try {
    await store().set({ [PANEL_ROUTE_KEY]: clean });
  } catch {
    /* local copy below */
  }
  try {
    await browser.storage.local.set({ [PANEL_ROUTE_KEY]: clean });
  } catch {
    /* ignore */
  }
}

export async function takeLedgerPanelRoute(): Promise<string | null> {
  let route: string | null = null;
  try {
    const stored = await store().get(PANEL_ROUTE_KEY);
    const value = stored?.[PANEL_ROUTE_KEY];
    if (typeof value === "string" && value.startsWith("/")) route = value;
    await store().remove(PANEL_ROUTE_KEY);
  } catch {
    /* local below */
  }
  try {
    const local = await browser.storage.local.get(PANEL_ROUTE_KEY);
    const value = local?.[PANEL_ROUTE_KEY];
    if (!route && typeof value === "string" && value.startsWith("/")) route = value;
    await browser.storage.local.remove(PANEL_ROUTE_KEY);
  } catch {
    /* ignore */
  }
  return route;
}

/** Broadcast hash for the dropdown that opens after a Nano sign. */
export async function saveLedgerLastTx(hash: string): Promise<void> {
  const clean = hash.trim();
  if (!clean) return;
  try {
    await store().set({ [LAST_TX_KEY]: clean });
  } catch {
    /* the local copy still reaches the next page */
  }
  try {
    await browser.storage.local.set({ [LAST_TX_KEY]: clean });
  } catch {
    /* ignore */
  }
}

export async function takeLedgerLastTx(): Promise<string | null> {
  let hash: string | null = null;
  try {
    const stored = await store().get(LAST_TX_KEY);
    const value = stored?.[LAST_TX_KEY];
    if (typeof value === "string" && value.trim()) hash = value.trim();
    await store().remove(LAST_TX_KEY);
  } catch {
    /* local below */
  }
  try {
    const local = await browser.storage.local.get(LAST_TX_KEY);
    const value = local?.[LAST_TX_KEY];
    if (!hash && typeof value === "string" && value.trim()) hash = value.trim();
    await browser.storage.local.remove(LAST_TX_KEY);
  } catch {
    /* ignore */
  }
  return hash;
}
