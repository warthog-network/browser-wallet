import React, { useEffect, useState } from "react";
import Button from "../components/Button";
import Header from "../components/Header";
import { useNavigate, useLocation } from "react-router-dom";
import useWallet from "../hooks/useWallet";
import { addressToSeed } from "../utils";
import Jazzicon from "react-jazzicon/dist/Jazzicon";
import { inspectWalletBlob } from "../utils/passkeyWallet";
import {
  decryptWallet,
  loadNamedWalletEncrypted,
} from "../utils/warthogWalletCrypto";
import {
  clearToolbarUnlock,
  isToolbarActionPopup,
  storeToolbarUnlock,
} from "../utils/passkeyHandoff";
import { openStableExtensionWindow } from "../utils/extensionNav";

const REVEAL_MS = 30_000;

type PasskeyFactor = {
  credentialId: string;
  transports?: string[];
};

function ShowPrivateKey() {
  const location = useLocation();
  const recovery = location.pathname === "/recovery-phrase";
  // A windows.create popup is still a popup view. This flag stops the stable
  // window from handing off to another window.
  const handedOff = new URLSearchParams(location.search).get("handoff") === "1";
  const {
    password,
    name,
    savedWalletName,
    signingUnlocked,
    wallet,
    pathType,
  } = useWallet();
  const navigate = useNavigate();
  const [enteredPassword, setEnteredPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPrivateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [savedBlob, setSavedBlob] = useState<string | null>(null);
  const [passwordOnFile, setPasswordOnFile] = useState(false);
  const [passkey, setPasskey] = useState<PasskeyFactor | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const needsPassword = passwordOnFile || Boolean(password);

  useEffect(() => {
    let alive = true;
    setAuthReady(false);
    (async () => {
      if (!savedWalletName) {
        if (!alive) return;
        setSavedBlob(null);
        setPasswordOnFile(false);
        setPasskey(null);
        setAuthReady(true);
        return;
      }
      try {
        const raw = await loadNamedWalletEncrypted(savedWalletName);
        const info = raw ? inspectWalletBlob(raw) : null;
        const block = info?.envelope?.passkey;
        if (!alive) return;
        setSavedBlob(raw);
        setPasswordOnFile(Boolean(info?.hasPassword));
        setPasskey(
          info?.hasPasskey && block?.credentialId
            ? {
                credentialId: String(block.credentialId),
                transports: Array.isArray(block.transports) ? block.transports : undefined,
              }
            : null,
        );
      } catch {
        if (!alive) return;
        setSavedBlob(null);
        setPasswordOnFile(false);
        setPasskey(null);
      } finally {
        if (alive) setAuthReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [savedWalletName]);

  useEffect(() => {
    if (!revealedKey) return;
    const timer = window.setTimeout(() => {
      setRevealedKey(null);
      setPrivateKeyVisible(false);
    }, REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealedKey]);

  useEffect(() => {
    if (signingUnlocked) return;
    setRevealedKey(null);
    setPrivateKeyVisible(false);
  }, [signingUnlocked]);

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEnteredPassword(e.target.value);
  };

  const passwordMatches = async (): Promise<boolean> => {
    if (savedBlob && passwordOnFile) {
      try {
        const decrypted = await decryptWallet(savedBlob, enteredPassword);
        decrypted.privateKey = "";
        decrypted.mnemonic = "";
        return true;
      } catch {
        setError("Incorrect password. Please try again.");
        return false;
      }
    }
    if (password && enteredPassword === password) return true;
    setError("Incorrect password. Please try again.");
    return false;
  };

  const handOffToWindow = async (): Promise<void> => {
    const { exportWalletFromWorker } = await import("../utils/signingBridge");
    const exported = await exportWalletFromWorker();
    try {
      await storeToolbarUnlock({
        privateKey: exported.privateKey,
        publicKey: exported.publicKey || "",
        address: exported.address || wallet || "",
        mnemonic: exported.mnemonic || undefined,
        pathType,
        password,
        name: name || "Account 0",
        savedWalletName,
      });
    } finally {
      exported.privateKey = "";
      exported.mnemonic = "";
    }
    try {
      await openStableExtensionWindow(`${location.pathname}?handoff=1`);
    } catch (err) {
      await clearToolbarUnlock();
      throw err;
    }
    try {
      window.close();
    } catch {
      // The toolbar panel may already be closing.
    }
  };

  const handleSubmit = async () => {
    setError(null);
    if (!signingUnlocked) {
      setError("Wallet is locked — unlock first.");
      return;
    }
    if (!authReady) return;
    if (!needsPassword && !passkey) {
      setError("Save this wallet with a password or a passkey before revealing the secret.");
      return;
    }
    setBusy(true);
    try {
      if (passkey && isToolbarActionPopup() && !handedOff) {
        await handOffToWindow();
        return;
      }
      if (needsPassword) {
        const ok = await passwordMatches();
        if (!ok) return;
      }
      if (passkey) {
        const { assertPasskey } = await import("../utils/passkeyWallet");
        await assertPasskey({
          credentialId: passkey.credentialId,
          transports: passkey.transports,
        });
      }
      const { exportWalletFromWorker } = await import("../utils/signingBridge");
      const exported = await exportWalletFromWorker();
      const secret = (recovery ? exported.mnemonic : exported.privateKey) || "";
      exported.privateKey = "";
      exported.mnemonic = "";
      if (!secret) throw new Error("No recovery phrase is available for this wallet");
      setRevealedKey(secret);
      setPrivateKeyVisible(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export key");
    } finally {
      setBusy(false);
    }
  };

  const handleDone = () => {
    setRevealedKey(null);
    navigate("/settings");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void handleSubmit();
    }
  };

  return (
    <div className="container min-h-screen flex flex-col items-center">
      <Header title={recovery ? "Recovery phrase" : "Warthog private key"} />

      <div className="flex items-center gap-4 mt-6">
        {<Jazzicon diameter={80} seed={addressToSeed(wallet || "")} />}
        <div>
          <div className="text-xl font-semibold text-white">{name}</div>
          <div className="text-xs text-white/50">Connected Wallet</div>
        </div>
      </div>
      {!isPrivateKeyVisible && signingUnlocked && needsPassword && (
        <div className="w-full max-w-sm mt-6">
          <label htmlFor="password" className="text-sm text-white font-normal">
            Enter password
          </label>
          <input
            id="password"
            type="password"
            className={`w-full bg-primary/10 text-white border rounded-lg px-4 py-2 mt-1 focus:outline-hidden ${error ? "border-red-500" : "border-primary/50"}`}
            placeholder="Your password..."
            value={enteredPassword}
            onChange={handlePasswordChange}
            onKeyDown={handleKeyDown}
          />
        </div>
      )}
      {!isPrivateKeyVisible && signingUnlocked && !needsPassword && passkey && (
        <p className="w-full max-w-sm mt-6 text-sm text-white/70">
          Confirm with your passkey to reveal this secret.
        </p>
      )}
      {error && <div className="text-red-500 text-sm mt-2 w-full max-w-sm">{error}</div>}

      {isPrivateKeyVisible && revealedKey && (
        <div className="mt-6">
          <p className="text-white text-sm">{recovery ? "Recovery phrase (all accounts and networks)" : "Warthog private key"}</p>
          <div className="px-3 py-3 rounded-lg border border-primary/25 backdrop-blur-md flex items-center w-full">
            <div className="text-white text-lg w-full wrap-break-word">
              {revealedKey}
            </div>
          </div>
          <p className="mt-2 text-xs text-white/50">Hides in 30 seconds.</p>

          <p className="mt-4 px-2.5 py-2 bg-[#d9d9d9]/10 rounded-lg">
            <span className="text-[#fa3333] text-sm font-normal">
              Warning:{" "}
            </span>
            <span className="text-white/80 text-sm">
              Never disclose this secret to anyone. It can be used
              to steal any assets held in your account.
            </span>
          </p>
        </div>
      )}

      <div className="mt-6 w-full gap-3 flex absolute bottom-3 px-4 left-0">
        {!isPrivateKeyVisible && signingUnlocked && (needsPassword || passkey) && (
          <>
            <Button
              className="w-full"
              onClick={() => navigate("/settings")}
              variant="outline"
            >
              Cancel
            </Button>
            <Button className="w-full" onClick={() => void handleSubmit()} variant="primary" disabled={!authReady || busy}>
              {passkey && !needsPassword ? "Confirm with passkey" : "Continue"}
            </Button>
          </>
        )}
        {!isPrivateKeyVisible && signingUnlocked && authReady && !needsPassword && !passkey && (
          <Button
            className="w-full"
            onClick={() => navigate("/settings")}
            variant="outline"
          >
            Back
          </Button>
        )}
        {isPrivateKeyVisible && revealedKey && (
          <Button className="w-full" onClick={handleDone} variant="primary">
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

export default ShowPrivateKey;
