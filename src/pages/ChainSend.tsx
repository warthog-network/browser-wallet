import { useEffect, useState } from "react";
import { ethers } from "ethers";
import Header from "../components/Header";
import SpendConfirm, { useSpendFlow } from "../components/SpendConfirm";
import { useChainAccounts } from "../chains/useChainAccounts";
import { sendEthAsset, sendEthCall, maxSendableEth } from "../mobile-port/utils/ethChain";
import { formatRawAmount } from "../mobile-port/utils/ethHoldings";
import { fetchBtcBalance, formatBtc, maxSendableBtc, sendBtc } from "../mobile-port/utils/networks/btc";
import { formatHemi, maxSendableHemi, sendHemi, sendHemiCall } from "../mobile-port/utils/networks/hemi";
import { formatSol, maxSolPayment, sendSol } from "../mobile-port/utils/networks/solana";
import { sendSpl } from "../mobile-port/utils/networks/solswap";
import { explainChainError } from "../mobile-port/utils/networks/http";
import { formatUnits, parseUnits } from "../mobile-port/utils/networks/units";
import { readOneBalance } from "../mobile-port/utils/tokenBalances";
import { defaultsFor, subscribeTokens, tokensFor, type WalletToken } from "../mobile-port/utils/walletTokens";
import TickerMenu from "../components/TickerMenu";
import { tokenMark } from "../components/chains/TokenMark";

const ERC20 = new ethers.Interface(["function transfer(address,uint256)"]);

const field = "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-primary";

function assetsFor(chain: string): WalletToken[] {
  if (chain === "ethereum" || chain === "hemi" || chain === "solana") return defaultsFor(chain);
  return [];
}

export default function ChainSend() {
  const { accounts, chain, phrasePending, addressError } = useChainAccounts();
  const flow = useSpendFlow();
  const [assetId, setAssetId] = useState("");
  const [listed, setListed] = useState<WalletToken[] | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setListed(null);
    setAssetId("");
    if (chain !== "ethereum" && chain !== "hemi" && chain !== "solana") return;
    let cancel = false;
    const load = () => {
      void tokensFor(chain).then((rows) => { if (!cancel) setListed(rows); });
    };
    load();
    const stop = subscribeTokens(() => { if (!cancel) load(); });
    return () => { cancel = true; stop(); };
  }, [chain]);

  const assets = listed ?? assetsFor(chain);
  const asset = assets.find((token) => token.id === assetId) ?? assets[0];
  const owner = !accounts
    ? ""
    : chain === "solana" ? accounts.solAddress : chain === "bitcoin" ? accounts.btcAddress : accounts.ethAddress;
  const unit = chain === "bitcoin" ? "BTC" : asset?.symbol ?? "";

  useEffect(() => {
    if (!owner || chain === "wart") return;
    let cancel = false;
    const load = chain === "bitcoin"
      ? fetchBtcBalance(owner).then(formatBtc)
      : asset
        ? readOneBalance(asset.network, owner, asset).then((raw) => formatUnits(raw, asset.decimals))
        : Promise.resolve(null);
    void load
      .then((next) => { if (!cancel) setHeld(next); })
      .catch(() => { if (!cancel) setHeld(null); });
    return () => { cancel = true; };
  }, [chain, owner, asset]);

  if (chain === "wart" || !accounts) {
    return (
      <div className="container">
        <Header title="Send" />
        <p className="text-sm text-white/70" role={addressError ? "alert" : "status"}>
          {phrasePending ? "Loading account addresses…" : addressError || "Choose Ethereum, Bitcoin, Hemi, or Solana on the home card. A private-key import stays on Warthog."}
        </p>
      </div>
    );
  }

  const fillMax = async () => {
    try {
      if (chain === "bitcoin") {
        setAmount(formatBtc(await maxSendableBtc(accounts.btcAddress)));
        return;
      }
      if (chain === "solana") {
        if (!asset || asset.native) {
          setAmount(formatSol(await maxSolPayment(accounts.solAddress)));
          return;
        }
        const raw = await readOneBalance("solana", accounts.solAddress, asset);
        setAmount(formatUnits(raw, asset.decimals));
        return;
      }
      if (asset?.native && chain === "ethereum") {
        setAmount(formatRawAmount(await maxSendableEth(accounts.ethAddress), 18, 6, false));
        return;
      }
      if (asset?.native && chain === "hemi") {
        setAmount(formatHemi(await maxSendableHemi(accounts.ethAddress)));
        return;
      }
      if (!asset) return;
      const raw = await readOneBalance(asset.network, owner, asset);
      setAmount(formatUnits(raw, asset.decimals));
    } catch (err) {
      setError(explainChainError(err));
    }
  };

  const send = async () => {
    const step = chain === "bitcoin"
      ? "Signing and broadcasting the Bitcoin payment…"
      : chain === "solana"
        ? "Signing and broadcasting the Solana payment…"
        : "Signing and waiting for the network…";
    flow.begin(step);
    try {
      if (chain === "bitcoin") {
        const sent = await sendBtc(to.trim(), amount.trim());
        flow.finish(true, "Sent", `${amount.trim()} BTC accepted. ${sent.txid.slice(0, 18)}…`);
        return;
      }
      if (chain === "solana") {
        if (!asset || asset.native) {
          const sent = await sendSol(to.trim(), amount.trim());
          flow.finish(true, "Sent", `${amount.trim()} SOL accepted. ${sent.signature.slice(0, 18)}…`);
          return;
        }
        const sent = await sendSpl({
          mint: asset.address,
          decimals: asset.decimals,
          toOwner: to.trim(),
          amount: amount.trim(),
          symbol: asset.symbol,
          program: asset.program,
        });
        flow.finish(true, "Sent", `${amount.trim()} ${asset.symbol} accepted. ${sent.signature.slice(0, 18)}…`);
        return;
      }
      if (!asset) throw new Error("Choose an asset.");
      if (chain === "ethereum" && (asset.symbol === "ETH" || asset.symbol === "USDT")) {
        const sent = await sendEthAsset(asset.symbol, to.trim(), amount.trim());
        flow.finish(true, "Sent", `${amount.trim()} ${asset.symbol} is confirmed on Ethereum. ${sent.hash.slice(0, 12)}…`);
        return;
      }
      const raw = parseUnits(amount.trim(), asset.decimals, asset.symbol);
      if (!asset.native) {
        const owned = await readOneBalance(asset.network, owner, asset);
        if (raw > owned) throw new Error(`Only ${formatUnits(owned, asset.decimals)} ${asset.symbol} is in this wallet.`);
      }
      const data = ERC20.encodeFunctionData("transfer", [
        ethers.getAddress(to.trim()),
        raw,
      ]);
      if (chain === "hemi") {
        const hash = asset.native
          ? (await sendHemi(to.trim(), amount.trim())).hash
          : await sendHemiCall({ to: asset.address, data });
        flow.finish(true, "Sent", `${amount.trim()} ${asset.symbol} is confirmed on Hemi. ${hash.slice(0, 12)}…`);
        return;
      }
      const receipt = await sendEthCall({ to: asset.address, data });
      flow.finish(true, "Sent", `${amount.trim()} ${asset.symbol} is confirmed on Ethereum. ${receipt.hash.slice(0, 12)}…`);
    } catch (err) {
      flow.finish(false, "Send failed", explainChainError(err));
    }
  };

  return (
    <div className="container space-y-3">
      <Header title={`Send ${unit}`} />
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {assets.length > 1 ? (
        <TickerMenu
          className="ticker-menu--field"
          ariaLabel="Asset"
          value={asset?.id ?? ""}
          onChange={setAssetId}
          items={assets.map((token) => ({
            id: token.id,
            label: token.symbol,
            symbol: tokenMark(token.symbol, chain === "hemi" ? "hemi" : token.network, token.native),
            hint: token.name !== token.symbol ? token.name : undefined,
          }))}
        />
      ) : null}
      {held != null ? <p className="text-xs text-white/50">Available <span className="bal-color">{held}</span> {unit}</p> : null}
      <input className={field} value={to} onChange={(event) => setTo(event.target.value)} placeholder="Recipient" />
      <div className="flex gap-2">
        <input className={field} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" inputMode="decimal" />
        <button type="button" className="shrink-0 rounded-lg border border-white/20 px-3 text-sm text-white" onClick={() => void fillMax()}>
          Max
        </button>
      </div>
      <p className="text-xs text-white/40">From {owner}</p>
      <button
        type="button"
        className="w-full rounded-lg bg-primary py-2 text-sm font-semibold text-black disabled:opacity-50"
        disabled={flow.busy || !amount.trim() || !to.trim()}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Review send
      </button>
      <SpendConfirm
        open={open}
        title={`Send ${unit}`}
        rows={[
          { label: "Amount", value: `${amount.trim() || "—"} ${unit}` },
          { label: "To", value: to.trim() || "—" },
          { label: "Network", value: chain === "bitcoin" ? "Bitcoin" : chain === "solana" ? "Solana" : chain === "hemi" ? "Hemi" : "Ethereum" },
        ]}
        confirmLabel={`Send ${unit}`}
        busy={flow.busy}
        step={flow.step}
        outcome={flow.outcome}
        onCancel={() => {
          flow.close(() => {
            setAmount("");
            setTo("");
          });
          setOpen(false);
        }}
        onConfirm={() => { void send(); }}
      />
    </div>
  );
}
