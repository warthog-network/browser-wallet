/**
 * Guided secure setup after create / restore — wartbunker parity.
 * Step 2: name + passkey/password  →  Step 3: write down seed → Save & open
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import useWallet from "../hooks/useWallet";
import { isWebAuthnAvailable } from "../utils/passkeyWallet";
import { isPasskeyHandedOff } from "../utils/passkeyHandoff";
import { clearPasskeyWaiting, paintPasskeyWaiting } from "../utils/passkeyUi";
import { newSessionToken } from "../utils/sessionToken";
import { encryptWallet } from "../utils/warthogWalletCrypto";

type SecureStep = "save" | "backup";
type Origin = "create" | "restore";

type LocationState = {
  origin?: Origin;
  walletName?: string;
};

function SecureSetup() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as LocationState;
  const {
    seedPhrase,
    setSeedPhrase,
    wallet,
    signingUnlocked,
    setPassword,
    setToken,
    setName,
    setNameList,
    pathType,
    saveCurrentAsNamedWallet,
  } = useWallet();

  const origin: Origin = state.origin === "restore" ? "restore" : "create";
  const [secureStep, setSecureStep] = useState<SecureStep>("save");
  const [walletName, setWalletName] = useState(state.walletName || "My Wallet");
  const [password, setPass] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [enablePasskey, setEnablePasskey] = useState(false);
  const [require2fa, setRequire2fa] = useState(false);
  const [passkeysSupported, setPasskeysSupported] = useState(false);
  const [consentToClose, setConsentToClose] = useState(false);
  const [downloadPassword, setDownloadPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [awaitingPasskey, setAwaitingPasskey] = useState(false);
  const [backupPrivateKey, setBackupPrivateKey] = useState<string | null>(null);

  // Passkey stays opt-in. A password alone is enough to save and unlock.
  useEffect(() => {
    setPasskeysSupported(isWebAuthnAvailable());
  }, []);

  useEffect(() => {
    if (!wallet && !signingUnlocked) {
      navigate("/", { replace: true });
    }
  }, [wallet, signingUnlocked, navigate]);

  const clearSeedRef = useRef(setSeedPhrase);
  clearSeedRef.current = setSeedPhrase;
  const setupMounted = useRef(false);
  useEffect(() => {
    setupMounted.current = true;
    return () => {
      setupMounted.current = false;
      // Strict mode remounts this effect immediately. Wait a turn so the
      // backup screen can show the phrase, then drop it once the screen is gone.
      window.setTimeout(() => {
        if (!setupMounted.current) clearSeedRef.current(null);
      }, 0);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void import("../utils/signingBridge").then(({ exportWalletFromWorker }) =>
      exportWalletFromWorker()
        .then((exported) => {
          const key = exported.privateKey || null;
          exported.privateKey = "";
          exported.mnemonic = null;
          if (!cancelled) setBackupPrivateKey(key);
        })
        .catch(() => {
          if (!cancelled) setBackupPrivateKey(null);
        }),
    );
    return () => {
      cancelled = true;
      setBackupPrivateKey(null);
    };
  }, []);

  const passwordsMatch = !confirmPassword || password === confirmPassword;

  const canContinueToBackup = () => {
    const name = walletName.trim();
    if (!name) {
      setError("Enter a wallet name first");
      return false;
    }
    const wantPasskey = enablePasskey && passkeysSupported;
    const wantPassword = Boolean(password);
    if (!wantPasskey && !wantPassword) {
      setError("Enable passkey and/or set a password for next login");
      return false;
    }
    if (wantPassword && password !== confirmPassword) {
      setError("Passwords do not match");
      return false;
    }
    if (require2fa && (!wantPassword || !wantPasskey)) {
      setError("2FA needs both a password and passkey");
      return false;
    }
    setError(null);
    return true;
  };

  const handleSaveAndOpen = async () => {
    if (!consentToClose) {
      setError("Confirm you have written down your seed phrase before closing");
      setSecureStep("backup");
      return;
    }
    const name = walletName.trim();
    if (!name) {
      setError("Enter a wallet name to save for next login");
      setSecureStep("save");
      return;
    }
    const wantPasskey = enablePasskey && passkeysSupported;
    const wantPassword = Boolean(password);
    if (!wantPasskey && !wantPassword) {
      setError("Enable passkey and/or set a password so you can unlock next time");
      setSecureStep("save");
      return;
    }
    if (wantPassword && password !== confirmPassword) {
      setError("Passwords do not match");
      setSecureStep("save");
      return;
    }
    if (require2fa && (!wantPassword || !wantPasskey)) {
      setError("2FA needs both a password and passkey");
      setSecureStep("save");
      return;
    }

    setError(null);
    setBusy(true);
    try {
      if (wantPasskey) {
        await paintPasskeyWaiting(setAwaitingPasskey);
      }
      if (password) {
        setPassword(password);
      }
      setToken(newSessionToken());
      setName(name);
      setNameList([name]);
      await saveCurrentAsNamedWallet(name, password || null, {
        withPasskey: wantPasskey,
        require2fa: require2fa && wantPassword && wantPasskey,
        preferFingerprint: false,
      });
      navigate("/home", { replace: true });
    } catch (e) {
      if (isPasskeyHandedOff(e)) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /cancel|not allowed|abort/i.test(msg)
          ? "Passkey cancelled — try Save & open again, or turn off passkey and use a password."
          : `Failed to save: ${msg}`,
      );
    } finally {
      clearPasskeyWaiting(setAwaitingPasskey);
      setBusy(false);
    }
  };

  const handleOpenWithoutSaving = async () => {
    if (!consentToClose) {
      setError("Confirm you have written down your seed phrase before closing");
      setSecureStep("backup");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setToken(newSessionToken());
      if (walletName.trim()) {
        setName(walletName.trim());
        setNameList([walletName.trim()]);
      }
      navigate("/home", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadPassword || !wallet) {
      setError("Enter a password to encrypt the file");
      return;
    }
    try {
      const { exportWalletFromWorker } = await import("../utils/signingBridge");
      const exported = await exportWalletFromWorker();
      const encrypted = await encryptWallet(
        {
          privateKey: exported.privateKey,
          publicKey: exported.publicKey || "",
          address: exported.address || wallet,
          mnemonic: exported.mnemonic || seedPhrase || undefined,
          pathType,
        },
        downloadPassword,
      );
      exported.privateKey = "";
      exported.mnemonic = null;
      const blob = new Blob([encrypted], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "warthog_wallet.txt";
      a.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };

  const canSaveAndOpen =
    consentToClose &&
    Boolean(walletName.trim()) &&
    ((enablePasskey && passkeysSupported) ||
      (password && password === confirmPassword)) &&
    !(require2fa && !(password && enablePasskey && passkeysSupported)) &&
    passwordsMatch &&
    !busy;

  return (
    <div className="container min-h-screen py-4 relative pb-8">
      <div className="mb-3">
        <h1 className="text-white text-xl font-semibold">
          {secureStep === "save"
            ? "Name & unlock options"
            : "Write down your seed phrase"}
        </h1>
        <p className="text-white/45 text-xs mt-1">
          {secureStep === "save"
            ? "Step 2 of 3 · set name, passkey, and optional password first"
            : "Step 3 of 3 · write the seed offline, then confirm before closing"}
        </p>
        <div className="flex gap-2 mt-3" aria-hidden>
          <span className="h-1.5 flex-1 rounded-full bg-primary/80" />
          <span
            className={`h-1.5 flex-1 rounded-full ${
              secureStep === "save" ? "bg-primary" : "bg-primary/80"
            }`}
          />
          <span
            className={`h-1.5 flex-1 rounded-full ${
              secureStep === "backup" ? "bg-primary" : "bg-white/15"
            }`}
          />
        </div>
      </div>

      {secureStep === "save" && (
        <div className="flex flex-col gap-3">
          <p className="text-white/50 text-xs">
            Choose how you&apos;ll unlock next time. The passkey is registered{" "}
            <strong className="text-white/70">once</strong> at the end — after
            you write down your seed.
          </p>
          <div>
            <label className="text-white text-sm">Wallet name</label>
            <input
              type="text"
              value={walletName}
              onChange={(e) => setWalletName(e.target.value)}
              placeholder="e.g. main"
              autoComplete="off"
              className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
            />
          </div>
          {passkeysSupported && (
            <>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={enablePasskey}
                  onChange={(e) => {
                    setEnablePasskey(e.target.checked);
                    if (!e.target.checked) setRequire2fa(false);
                  }}
                />
                <span className="text-white text-sm">
                  Enable passkey unlock (optional)
                </span>
              </label>
              <p className="text-white/40 text-[11px] leading-relaxed -mt-1 pl-6">
                Google Password Manager or this device can save it. Proton Pass
                cannot store a passkey for a browser extension. After the
                prompt, the wallet returns to the toolbar.
              </p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={require2fa}
                  onChange={(e) => {
                    setRequire2fa(e.target.checked);
                    if (e.target.checked) setEnablePasskey(true);
                  }}
                />
                <span className="text-white text-sm">
                  Optional 2FA: require password + passkey together
                </span>
              </label>
            </>
          )}
          <div>
            <label className="text-white text-sm">
              {require2fa
                ? "Password (required for 2FA)"
                : enablePasskey
                  ? "Password (optional)"
                  : "Password"}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPass(e.target.value)}
              placeholder="Strong password"
              autoComplete="new-password"
              className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
            />
          </div>
          <div>
            <label className="text-white text-sm">Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              autoComplete="new-password"
              className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
            />
            {!passwordsMatch && (
              <p className="text-red-400 text-xs mt-1">Passwords do not match</p>
            )}
          </div>
          <div className="border-t border-white/10 pt-3 mt-1">
            <label className="text-white/60 text-xs">
              Optional: download encrypted file
            </label>
            <input
              type="password"
              value={downloadPassword}
              onChange={(e) => setDownloadPassword(e.target.value)}
              placeholder="Password for the file"
              className="w-full bg-primary/10 text-white border border-primary/50 rounded-lg px-4 py-2 mt-1"
            />
            <Button
              variant="outline"
              className="w-full mt-2"
              disabled={!downloadPassword || busy}
              onClick={handleDownload}
            >
              Download warthog_wallet.txt
            </Button>
          </div>
          <Button
            variant="primary"
            className="w-full mt-2"
            disabled={busy || !walletName.trim()}
            onClick={() => {
              if (canContinueToBackup()) setSecureStep("backup");
            }}
          >
            Continue — write down seed phrase
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => navigate("/", { replace: true })}
          >
            Cancel
          </Button>
        </div>
      )}

      {secureStep === "backup" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-amber-950/50 border border-amber-800/60 px-3 py-3 text-sm text-amber-200">
            <strong>Critical:</strong> Write your seed phrase offline and store
            it safely. Anyone with these words can take your funds. Confirm you
            have written them down before closing.
          </div>
          {walletName && (
            <p className="text-white/50 text-xs">
              Wallet name:{" "}
              <span className="font-mono text-emerald-400">{walletName}</span>
            </p>
          )}
          {seedPhrase && (
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <p className="text-amber-400 text-xs font-medium mb-1">
                SEED PHRASE
              </p>
              <p className="text-white text-sm wrap-break-word select-text">
                {seedPhrase}
              </p>
            </div>
          )}
          {backupPrivateKey && (
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <p className="text-red-400 text-xs font-medium mb-1">PRIVATE KEY</p>
              <p className="text-white text-xs font-mono break-all select-text">
                {backupPrivateKey}
              </p>
            </div>
          )}
          {wallet && (
            <div className="rounded-lg bg-white/5 border border-white/10 p-3">
              <p className="text-emerald-400 text-xs font-medium mb-1">ADDRESS</p>
              <p className="text-white text-xs font-mono break-all select-text">
                {wallet}
              </p>
            </div>
          )}
          {origin === "restore" && !seedPhrase && (
            <p className="text-white/40 text-xs">
              Restored from private key — no seed phrase on this wallet.
            </p>
          )}

          <label className="flex items-start gap-2 cursor-pointer mt-1">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={consentToClose}
              onChange={(e) => setConsentToClose(e.target.checked)}
            />
            <span className="text-white text-sm">
              I confirm I have written down my seed phrase before closing
            </span>
          </label>

          <Button
            variant="primary"
            className="w-full"
            disabled={!canSaveAndOpen}
            onClick={() => void handleSaveAndOpen()}
          >
            {awaitingPasskey
              ? "Waiting for passkey…"
              : busy
                ? "Saving…"
                : enablePasskey && passkeysSupported
                  ? "Save & open (register passkey once)"
                  : "Save & open wallet"}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={!consentToClose || busy}
            onClick={() => void handleOpenWithoutSaving()}
          >
            Open without saving
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => {
              setSecureStep("save");
              setError(null);
            }}
          >
            ← Back to unlock options
          </Button>
        </div>
      )}

      {error && (
        <p className="text-red-400 text-sm mt-3" role="alert">
          {error}
        </p>
      )}

      {awaitingPasskey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-xl border border-primary/40 bg-[#1a1a1a] px-6 py-5 max-w-sm text-center">
            <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-white font-medium">Waiting for passkey…</p>
            <p className="text-white/50 text-xs mt-1">
              Complete the browser or device prompt (PIN, biometrics, or
              password manager).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default SecureSetup;
