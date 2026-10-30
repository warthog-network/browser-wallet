import { QRCodeSVG } from "qrcode.react";
import Header from "../components/Header";
import { useChainAccounts } from "../chains/useChainAccounts";
import useWallet from "../hooks/useWallet";
import { toast } from "../utils/toast";

export default function ReceivePage() {
  const { network, address, addressError } = useChainAccounts();
  const { name } = useWallet();
  return <div className="container">
    <Header title="Receive" />
    <div className="flex flex-col items-center gap-5 py-5">
      <p className="text-sm font-semibold">{name} · {network.label}</p>
      {address ? <div className="bg-white p-4 rounded-xl"><QRCodeSVG value={address} size={200} /></div> : addressError ? <p role="alert">{addressError}</p> : <p role="status">Loading address…</p>}
      <p className="text-xs font-mono break-all text-center text-zinc-300">{address}</p>
      <p className="text-xs text-zinc-500 text-center">Only send assets on {network.label} to this address. Assets sent on the wrong network may be lost.</p>
      <button className="defi-btn-primary" disabled={!address} onClick={() => void navigator.clipboard.writeText(address).then(() => toast.success("Address copied", network.label)).catch(() => toast.error("Copy failed", "Try again"))}>Copy address</button>
    </div>
  </div>;
}
