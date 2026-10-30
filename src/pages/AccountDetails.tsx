import { useState } from "react";
import Header from "../components/Header";
import useWallet from "../hooks/useWallet";
import { encryptWallet } from "../utils/warthogWalletCrypto";
import { exportWalletFromWorker } from "../utils/signingBridge";
import { isWebAuthnAvailable } from "../utils/passkeyWallet";
import { isPasskeyHandedOff } from "../utils/passkeyHandoff";
import { clearPasskeyWaiting, paintPasskeyWaiting } from "../utils/passkeyUi";

export default function AccountDetails() {
  const { name, savedWalletName, nameList, selectedWalletIndex, setName, setNameList, password, pathType, ledgerAccount, saveCurrentAsNamedWallet, enablePasskeyOnCurrentWallet } = useWallet();
  const [accountName, setAccountName] = useState(name || "");
  const [saveName, setSaveName] = useState(savedWalletName || name || "My Wallet");
  const [backupPassword, setBackupPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [awaitingPasskey, setAwaitingPasskey] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const pwd = backupPassword || password;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setStatus("");
    try { await action(); }
    catch (err) { if (!isPasskeyHandedOff(err)) setError(err instanceof Error ? err.message : "Operation failed"); }
    finally { clearPasskeyWaiting(setAwaitingPasskey, setBusy); }
  };
  const download = async () => {
    if (!pwd) throw new Error("Enter a password to encrypt the backup");
    const exported = await exportWalletFromWorker();
    try {
      const encrypted = await encryptWallet({ privateKey: exported.privateKey, publicKey: exported.publicKey || "", address: exported.address || "", mnemonic: exported.mnemonic || undefined, pathType }, pwd);
      const url = URL.createObjectURL(new Blob([encrypted], { type: "text/plain" }));
      const link = document.createElement("a"); link.href = url; link.download = "warthog_wallet.txt"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Encrypted backup downloaded");
    } finally { exported.privateKey = ""; exported.mnemonic = null; }
  };
  return <div className="container">
    <Header title="Account and security" />
    <h2 className="wallet-section-label">Account name</h2>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!accountName.trim()) return;
      setName(accountName.trim());
      setNameList(nameList.map((item, index) => index === selectedWalletIndex ? accountName.trim() : item));
      setStatus("Account renamed");
    }}>
      <input className="defi-input" aria-label="Account name" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
      <button className="defi-compact-btn" disabled={!accountName.trim()}>Save name</button>
    </form>
    {ledgerAccount ? <p className="text-xs text-zinc-400 mt-5">Your keys stay on the Ledger. The extension cannot export its recovery phrase or private key.</p> : <>
      <h2 className="wallet-section-label">Encrypted backup and saved wallet</h2>
      <p className="text-xs text-zinc-500 mb-3">A seed-wallet backup contains the recovery phrase for all accounts and networks. Account names and custom nodes remain local preferences.</p>
      <label className="defi-label">Saved wallet name<input className="defi-input" value={saveName} onChange={(event) => setSaveName(event.target.value)} /></label>
      <label className="defi-label">Encryption password<input className="defi-input" type="password" autoComplete="new-password" placeholder={password ? "Use unlock password, or enter a new one" : "Required for password backup"} value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} /></label>
      <div className="defi-btn-row">
        <button className="defi-compact-btn" disabled={busy || !saveName.trim()} onClick={() => void run(async () => {
          if (!pwd) throw new Error("Enter an encryption password");
          await saveCurrentAsNamedWallet(saveName.trim(), pwd);
          setStatus(`Saved as ${saveName.trim()}`);
        })}>Save for quick login</button>
        <button className="defi-compact-btn" disabled={busy} onClick={() => void run(download)}>Download encrypted file</button>
      </div>
      <h2 className="wallet-section-label">Passkey and 2FA</h2>
      <p className="text-xs text-zinc-500 mb-3">Register or replace the passkey for the saved wallet name above.</p>
      <label className="flex gap-2 text-xs mb-3"><input type="checkbox" checked={twoFactor} onChange={(event) => setTwoFactor(event.target.checked)} disabled={busy} />Require password and passkey at unlock</label>
      <button className="defi-compact-btn" disabled={busy || !isWebAuthnAvailable() || !saveName.trim()} onClick={() => void run(async () => {
        if (twoFactor && !pwd) throw new Error("Enter a password for 2FA");
        await paintPasskeyWaiting(setAwaitingPasskey, setBusy);
        await enablePasskeyOnCurrentWallet({ password: pwd, name: saveName.trim(), require2fa: twoFactor, preferFingerprint: false });
        setStatus(twoFactor ? "Passkey and 2FA enabled" : "Passkey registered");
      })}>{awaitingPasskey ? "Waiting for passkey…" : twoFactor ? "Register passkey with 2FA" : "Register passkey"}</button>
    </>}
    {error && <p className="defi-error mt-4">{error}</p>}{status && <p className="defi-success mt-4">{status}</p>}
    {awaitingPasskey && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" role="status"><p>Confirm the passkey prompt in your browser.</p></div>}
  </div>;
}
