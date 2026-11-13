/**
 * Guided wallet access hub — mirrors wartbunker BalanceCardAccess.
 * One path at a time; never dumps every method on screen.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "../components/Button";
import useWallet from "../hooks/useWallet";
import {
  listLedgerBookmarks,
  readLedgerWindowMode,
  type LedgerBookmark,
  type LedgerWindowMode,
} from "../ledger/session";
import {
  getSavedWalletEntries,
  type SavedWalletEntry,
} from "../utils/warthogWalletCrypto";
import type { PathType, WordCount } from "../utils/walletKeys";
import LedgerWindowSetting from "../components/LedgerWindowSetting";
import {
  finishLedgerDeviceStep,
  isToolbarActionPopup,
  openLedgerHost,
  openLedgerInSidePanel,
} from "../ledger/shell";
import { hostBrowserName } from "../utils/browserName";

type AccessPath = "hub" | "login" | "create" | "have" | "derive" | "import" | "load" | "ledger";

function StartedPage() {
  const browserName = hostBrowserName();
  const navigate = useNavigate();
  const { newWallet, importWallet, importPrivateKey, loginWithLedger } = useWallet();
  const [path, setPath] = useState<AccessPath>("hub");
  const [entries, setEntries] = useState<SavedWalletEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<LedgerBookmark[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowMode, setWindowMode] = useState<LedgerWindowMode>("dropdown");

  // Create / derive fields
  const [walletName, setWalletName] = useState("");
  const [ledgerOrigin, setLedgerOrigin] = useState<"have" | "create">("have");
  const [wordCount, setWordCount] = useState<WordCount>(12);
  const [pathType, setPathType] = useState<PathType>("hardened");
  const [mnemonic, setMnemonic] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const savedCount = entries.length + bookmarks.length;
  const hasSaved = savedCount > 0;

  const refreshSaved = () => {
    getSavedWalletEntries().then(setEntries).catch(() => setEntries([]));
    listLedgerBookmarks().then(setBookmarks).catch(() => setBookmarks([]));
  };

  useEffect(() => {
    refreshSaved();
    void readLedgerWindowMode().then(setWindowMode);
  }, []);

  const goPath = (next: AccessPath) => {
    setPath(next);
    setError(null);
    setMnemonic("");
    setPrivateKey("");
    if (next === "hub" || next === "login") refreshSaved();
  };

  const pathTitle: Record<AccessPath, string> = {
    hub: hasSaved ? "Welcome back" : "Get started",
    login: "Unlock wallet",
    create: "Create wallet",
    have: "Restore wallet",
    derive: "Seed phrase",
    import: "Private key",
    load: "Wallet file",
    ledger: "Ledger",
  };

  const pathHint: Record<AccessPath, string> = {
    hub: hasSaved
      ? bookmarks.length
        ? "Unlock a saved name. A Ledger name connects the Nano."
        : "Unlock with passkey or password, or start another path."
      : "Create a wallet, then unlock it with a password. A passkey is optional.",
    login: "Choose a saved wallet, then unlock with passkey, password, or Ledger.",
    create: "Name the wallet. Then create it from a new seed, or connect the Nano.",
    have: "How do you want to restore access?",
    derive: "Enter the 12 or 24 word phrase for this wallet.",
    import: "Paste the 64-character private key.",
    load: "Open an encrypted warthog_wallet.txt file, then name it to save in this extension.",
    ledger: "Open the Warthog app on the Nano S+. The address is confirmed on the device.",
  };

  const showBack = path !== "hub";
  const backTarget: AccessPath =
    path === "ledger" && ledgerOrigin === "create"
      ? "create"
      : ["derive", "import", "load", "ledger"].includes(path)
        ? "have"
        : "hub";

  const handleCreate = async () => {
    const name = walletName.trim();
    if (!name) {
      setError("Enter a wallet name first (e.g. main)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await newWallet(wordCount, pathType);
      navigate("/secure-setup", {
        state: { origin: "create", walletName: name },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleDerive = async () => {
    if (!mnemonic.trim()) {
      setError("Enter your seed phrase");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await importWallet(mnemonic.trim(), pathType, wordCount);
      navigate("/secure-setup", {
        state: { origin: "restore", walletName: walletName.trim() || "Restored" },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to recover wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleLedger = async () => {
    setBusy(true);
    setError(null);
    try {
      const accountName = walletName.trim() || "Ledger";
      const query = new URLSearchParams({
        op: "connect",
        path: pathType,
        name: accountName,
        index: "0",
      });
      if (isToolbarActionPopup()) {
        if (windowMode === "sidepanel") {
          const opened = await openLedgerInSidePanel(`/ledger-host?${query.toString()}`);
          if (opened) {
            window.close();
            return;
          }
        }
        await openLedgerHost(query.toString());
        window.close();
        return;
      }
      await loginWithLedger(pathType, accountName);
      await finishLedgerDeviceStep(() => navigate("/home"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ledger login failed");
    } finally {
      setBusy(false);
    }
  };

  const handleImportKey = async () => {
    const pk = privateKey.trim().replace(/^0x/i, "");
    if (pk.length !== 64) {
      setError("Private key must be exactly 64 hex characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await importPrivateKey(pk);
      navigate("/secure-setup", {
        state: { origin: "restore", walletName: walletName.trim() || "Imported" },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import key");
    } finally {
      setBusy(false);
    }
  };

  const PathButton = ({
    label,
    meta,
    primary,
    onClick,
  }: {
    label: string;
    meta: string;
    primary?: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`w-full text-left rounded-xl border px-4 py-3 transition ${
        primary
          ? "border-primary bg-primary/15 hover:bg-primary/20"
          : "border-primary/25 bg-white/5 hover:bg-white/10"
      }`}
    >
      <div className="text-white font-medium text-sm">{label}</div>
      <div className="text-white/45 text-xs mt-0.5">{meta}</div>
    </button>
  );

  return (
    <div className="container min-h-screen flex flex-col py-4 px-1">
      <div className="flex justify-center items-center pt-1 pb-3">
        <img
          src="/fullLogo.png"
          alt="WARTHOG NETWORK"
          className="max-h-24 object-contain"
        />
      </div>

      <div className="flex-1 flex flex-col gap-3">
        <div>
          {showBack ? (
            <button
              type="button"
              className="text-primary text-xs mb-2 hover:underline disabled:opacity-40"
              onClick={() => goPath(backTarget)}
              disabled={busy}
            >
              ← Back
            </button>
          ) : (
            <p className="text-white/40 text-[11px] uppercase tracking-wide mb-1">
              No wallet open
            </p>
          )}
          <h1 className="text-white text-xl font-semibold">{pathTitle[path]}</h1>
          <p className="text-white/50 text-xs mt-1 leading-relaxed">
            {pathHint[path]}
          </p>
        </div>

        {/* ── Hub ── */}
        {path === "hub" && (
          <div className="flex flex-col gap-2.5 mt-1">
            {hasSaved && (
              <PathButton
                primary
                label="Unlock saved wallet"
                meta={`${savedCount} in this extension${
                  entries.some((e) => e.hasPasskey) ? " · passkey ready" : ""
                }${bookmarks.length ? " · Ledger" : ""}`}
                onClick={() => navigate("/login-saved")}
              />
            )}
            <PathButton
              primary={!hasSaved}
              label="Create new wallet"
              meta="Name, then a new seed or Ledger"
              onClick={() => goPath("create")}
            />
            <PathButton
              label={
                hasSaved ? "Other restore options" : "I already have a wallet"
              }
              meta="Seed, key, or file"
              onClick={() => goPath("have")}
            />
            <LedgerWindowSetting />
          </div>
        )}

        {/* ── Have ── */}
        {path === "have" && (
          <div className="flex flex-col gap-2.5 mt-1">
            {hasSaved && (
              <PathButton
                label="Saved in this extension"
                meta={`${savedCount} wallet${savedCount === 1 ? "" : "s"}`}
                onClick={() => navigate("/login-saved")}
              />
            )}
            <PathButton
              label="Seed phrase"
              meta="12 or 24 words"
              onClick={() => goPath("derive")}
            />
            <PathButton
              label="Private key"
              meta="64-character hex"
              onClick={() => goPath("import")}
            />
            <PathButton
              label="Encrypted file"
              meta="warthog_wallet.txt"
              onClick={() => navigate("/login-file")}
            />
            <PathButton
              label="Ledger"
              meta="Nano S+ with the Warthog app open"
              onClick={() => {
                setLedgerOrigin("have");
                goPath("ledger");
              }}
            />
          </div>
        )}

        {/* ── Create: name first ── */}
        {path === "create" && (
          <div className="flex flex-col gap-3 mt-1">
            <p className="text-white/45 text-xs">
              Name it, then create a new seed or connect the Nano. The Ledger
              keeps the key. You confirm the address on the device.
            </p>
            <div>
              <label className="text-white text-sm">Wallet name</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. main"
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && walletName.trim()) void handleCreate();
                }}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1 focus:outline-hidden focus:border-primary"
              />
            </div>
            <div>
              <label className="text-white text-sm">Word count</label>
              <select
                value={wordCount}
                onChange={(e) => setWordCount(Number(e.target.value) as WordCount)}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1 focus:outline-hidden focus:border-primary"
              >
                <option value={12}>12 words</option>
                <option value={24}>24 words</option>
              </select>
            </div>
            <div>
              <label className="text-white text-sm">Path</label>
              <select
                value={pathType}
                onChange={(e) => setPathType(e.target.value as PathType)}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1 focus:outline-hidden focus:border-primary"
              >
                <option value="hardened">Hardened BIP44</option>
                <option value="non-hardened">Legacy / non-hardened</option>
              </select>
            </div>
            <Button
              variant="primary"
              className="w-full mt-1"
              disabled={busy || !walletName.trim()}
              onClick={() => void handleCreate()}
            >
              {busy ? "Generating…" : "Create with a new seed"}
            </Button>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy || !walletName.trim()}
              onClick={() => {
                setLedgerOrigin("create");
                goPath("ledger");
              }}
            >
              Connect Ledger
            </Button>
          </div>
        )}

        {/* ── Derive ── */}
        {path === "derive" && (
          <div className="flex flex-col gap-3 mt-1">
            <div>
              <label className="text-white text-sm">Seed phrase</label>
              <textarea
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="12 or 24 words"
                rows={3}
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1 focus:outline-hidden focus:border-primary text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-white text-sm">Words</label>
                <select
                  value={wordCount}
                  onChange={(e) =>
                    setWordCount(Number(e.target.value) as WordCount)
                  }
                  className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-3 py-2 mt-1"
                >
                  <option value={12}>12</option>
                  <option value={24}>24</option>
                </select>
              </div>
              <div>
                <label className="text-white text-sm">Path</label>
                <select
                  value={pathType}
                  onChange={(e) => setPathType(e.target.value as PathType)}
                  className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-3 py-2 mt-1"
                >
                  <option value="hardened">BIP44</option>
                  <option value="non-hardened">Legacy</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-white text-sm">Wallet name (optional)</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. restored"
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
              />
            </div>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy || !mnemonic.trim()}
              onClick={() => void handleDerive()}
            >
              {busy ? "Working…" : "Recover wallet"}
            </Button>
          </div>
        )}

        {path === "ledger" && (
          <div className="flex flex-col gap-3 mt-1">
            <p className="text-white/45 text-xs">
              Open the Warthog app on the Nano. {browserName} lists the device,
              then the Nano shows the address. This session can send WART. Swaps
              stay on a software wallet.
            </p>
            <LedgerWindowSetting />
            <div>
              <label className="text-white text-sm">Path</label>
              <select
                value={pathType}
                onChange={(e) => setPathType(e.target.value as PathType)}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
              >
                <option value="hardened">Hardened BIP44</option>
                <option value="non-hardened">Legacy / non-hardened</option>
              </select>
            </div>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy}
              onClick={() => void handleLedger()}
            >
              {busy ? "Waiting for the Ledger…" : "Connect Ledger"}
            </Button>
          </div>
        )}

        {/* ── Import key ── */}
        {path === "import" && (
          <div className="flex flex-col gap-3 mt-1">
            <div>
              <label className="text-white text-sm">Private key</label>
              <input
                type="text"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleImportKey();
                }}
                placeholder="64-character hex"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-white text-sm">Wallet name (optional)</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. imported"
                className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
              />
            </div>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy || !privateKey}
              onClick={() => void handleImportKey()}
            >
              {busy ? "Working…" : "Import wallet"}
            </Button>
          </div>
        )}

        {error && (
          <p className="text-red-400 text-sm" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export default StartedPage;
