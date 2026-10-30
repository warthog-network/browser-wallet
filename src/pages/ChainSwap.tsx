import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Header from "../components/Header";
import SpendConfirm, { useSpendFlow } from "../components/SpendConfirm";
import SwapStyleCard from "../components/SwapStyleCard";
import {
  loadBtcProgress,
  loadEthProgress,
  loadLifiProgress,
  type MoveCard,
  type MoveFinish,
} from "../chains/tunnelProgress";
import { CHAIN_LABEL, useChainAccounts, type BrowserChain } from "../chains/useChainAccounts";
import { toast } from "../utils/toast";
import { counterpartToken, jupTunnelPair, lockedSwapRoute, tunnelEnds, type SwapDirection } from "../chains/swapRoutes";
import {
  executeSushiPair,
  quoteSushiPair,
  type SushiLeg,
  type SushiPairQuote,
} from "../mobile-port/utils/ethChain";
import { ETH_WETH } from "../mobile-port/utils/ethTokens";
import { explainChainError } from "../mobile-port/utils/networks/http";
import {
  executeHemiSushi,
  quoteHemiSushiPair,
  type HemiSushiLeg,
  type HemiSushiQuote,
} from "../mobile-port/utils/networks/hemiSushi";
import {
  executeStargate,
  quoteStargate,
  saveStargateMove,
  stargateStep,
  syncStargateMoves,
  type StargateMove,
  type StargateQuote,
} from "../mobile-port/utils/networks/stargate";
import {
  executeSwap,
  quoteSwapAssets,
  type SwapAsset,
  type SwapQuote,
} from "../mobile-port/utils/networks/solswap";
import { WSOL_MINT } from "../mobile-port/utils/networks/chains";
import {
  BRIDGE_ETH,
  BRIDGE_SOL,
  bridgeAssets,
  executeJupBridge,
  formatBridgeAmount,
  quoteJupBridge,
  type JupBridgeAsset,
  type JupBridgeRoute,
} from "../mobile-port/utils/networks/jupBridge";
import {
  executeLifiSwap,
  formatLifi,
  formatLifiWait,
  lifiStep,
  listLifiRoutes,
  quoteLifiSwap,
  saveLifiMove,
  type LifiAsset,
  type LifiRoute,
} from "../mobile-port/utils/networks/lifiSwap";
import { depositToHemi, fetchHemiBtcBalance, mintHemiDeposit, withdrawToBitcoin, type TunnelMove } from "../mobile-port/utils/networks/tunnel";
import { fetchHemiBalance } from "../mobile-port/utils/networks/hemi";
import { fetchBtcBalance } from "../mobile-port/utils/networks/btc";
import {
  depositEth,
  finalizeWithdrawal,
  readL1Eth,
  markEthMove,
  proveWithdrawal,
  readWithdrawalStage,
  saveEthMove,
  stageError,
  storedWithdrawal,
  withdrawEth,
  withdrawalFields,
  type EthMove,
} from "../mobile-port/utils/networks/ethBridge";
import { formatUnits, parseUnits } from "../mobile-port/utils/networks/units";
import { readOneBalance } from "../mobile-port/utils/tokenBalances";
import { defaultsFor, type WalletToken } from "../mobile-port/utils/walletTokens";
import { tokenMark } from "../components/chains/TokenMark";

const chip = "swap-chip-btn";
const chipOn = "swap-chip-btn swap-chip-btn--active";

type Chain = Exclude<BrowserChain, "wart">;

function bridgeRow(asset: JupBridgeAsset): WalletToken & { network: "ethereum" | "solana" } {
  return {
    id: `bridge:${asset.chain}:${asset.symbol}`,
    network: asset.chain,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    native: asset.native,
  };
}

function bridgeAsset(token: WalletToken): JupBridgeAsset {
  if (token.network !== "ethereum" && token.network !== "solana") {
    throw new Error("That asset does not bridge.");
  }
  const found = bridgeAssets(token.network).find((asset) => asset.symbol === token.symbol);
  if (!found) throw new Error(`${token.symbol} does not bridge on that chain.`);
  return found;
}

function sushiLeg(token: WalletToken): SushiLeg {
  return {
    symbol: token.symbol,
    address: token.native ? ETH_WETH : token.address,
    decimals: token.decimals,
    native: token.native,
  };
}

function hemiLeg(token: WalletToken): HemiSushiLeg {
  return {
    symbol: token.symbol,
    address: token.native ? "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" : token.address,
    decimals: token.decimals,
    native: token.native,
  };
}

function solAsset(token: WalletToken): SwapAsset {
  return {
    symbol: token.symbol,
    mint: token.native ? WSOL_MINT : token.address,
    decimals: token.decimals,
    native: token.native,
  };
}

type Draft =
  | { kind: "sushi"; quote: SushiPairQuote; text: string }
  | { kind: "hemi-sushi"; quote: HemiSushiQuote; text: string }
  | { kind: "stargate"; quote: StargateQuote; text: string }
  | { kind: "sol"; quote: SwapQuote; text: string }
  | { kind: "bridge"; route: JupBridgeRoute; text: string }
  | { kind: "lifi"; route: LifiRoute; from: LifiAsset; to: LifiAsset; amountIn: bigint; text: string }
  | { kind: "btc"; direction: "to-hemi" | "to-bitcoin"; amount: string; text: string }
  | { kind: "eth"; direction: "deposit" | "withdraw"; amount: bigint; text: string };

export default function ChainSwap({ chain }: { chain: Chain }) {
  const { accounts, phrasePending, addressError } = useChainAccounts();
  const flow = useSpendFlow();
  const location = useLocation();
  const requested = (location.state as { mode?: string } | null)?.mode;
  const [mode, setMode] = useState<"swap" | "tunnel">(
    requested === "tunnel" || chain === "bitcoin" ? "tunnel" : "swap",
  );
  const [amount, setAmount] = useState("");
  const [payId, setPayId] = useState("");
  const [receiveId, setReceiveId] = useState("");
  const [venue, setVenue] = useState<"stargate" | "sushi">("stargate");
  const [target, setTarget] = useState("");
  const [direction, setDirection] = useState<SwapDirection>("deposit");
  const [slippage, setSlippage] = useState(100);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [stargateCards, setStargateCards] = useState<MoveCard[]>([]);
  const [btcCards, setBtcCards] = useState<MoveCard[]>([]);
  const [ethCards, setEthCards] = useState<MoveCard[]>([]);
  const [lifiCards, setLifiCards] = useState<MoveCard[]>([]);
  const [available, setAvailable] = useState<{ raw: bigint; decimals: number } | null>(null);
  const confirmRef = useRef(false);
  const trackingStargate = useRef<string | null>(null);
  const trackingBtc = useRef<string | null>(null);
  const trackingEth = useRef<string | null>(null);
  const trackingLifi = useRef<string | null>(null);
  const told = useRef(new Set<string>());
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const noteRef = useRef(flow.note);
  const finishRef = useRef(flow.finish);
  confirmRef.current = open;
  noteRef.current = flow.note;
  finishRef.current = flow.finish;

  const eth = accounts?.ethAddress ?? "";
  const btc = accounts?.btcAddress ?? "";
  const sol = accounts?.solAddress ?? "";

  function releaseSheet(onSuccess?: () => void) {
    confirmRef.current = false;
    trackingStargate.current = null;
    trackingBtc.current = null;
    trackingEth.current = null;
    trackingLifi.current = null;
    flow.close(onSuccess);
    setOpen(false);
  }

  /** Keep the named step on an open sheet. A chip change closes the sheet, so say it in a toast instead. */
  function holdOrToast(step: string, message: string) {
    if (confirmRef.current) flow.hold(step, message);
    else toast.info(step, message);
  }

  function reportFinish(item: MoveFinish, watching: boolean) {
    const key = `${item.id}:${item.ok ? "ok" : "fail"}`;
    if (told.current.has(key)) return;
    told.current.add(key);
    if (watching && confirmRef.current) {
      finishRef.current(item.ok, item.step, item.message);
      return;
    }
    if (!item.announce) return;
    const title = item.toastTitle || item.step;
    const message = item.toastMessage || item.message;
    if (item.ok) toast.success(title, message);
    else toast.error(title, message);
  }

  useEffect(() => {
    if (!eth && !btc && !sol) return undefined;
    let cancel = false;
    const run = async () => {
      if (eth) {
        try {
          const synced = await syncStargateMoves(eth);
          if (cancel) return;
          setStargateCards(synced.open.slice(0, 5).map(({ move, view }) => ({
            id: move.id,
            txHash: move.txHash,
            title: move.direction === "to-hemi" ? "Ethereum → Hemi" : "Hemi → Ethereum",
            meta: `${formatUnits(BigInt(move.amountIn || "0"), 18)} ETH`,
            step: view.step,
            message: view.message,
            spinning: view.spinning,
            failed: view.failed,
            action: "",
            href: `https://layerzeroscan.com/tx/${move.txHash}`,
            link: "LayerZero Scan",
          })));
          for (const item of synced.changed) {
            const watching = trackingStargate.current === item.move.txHash;
            if (watching) trackingStargate.current = null;
            reportFinish({
              id: item.move.id,
              txHash: item.move.txHash,
              step: item.view.done ? "ETH arrived" : item.view.step,
              message: item.view.message,
              ok: item.view.done,
              announce: true,
              toastTitle: item.view.done ? "ETH arrived" : item.view.step,
              toastMessage: item.view.message,
            }, watching);
          }
          const watch = trackingStargate.current;
          const current = synced.open.find((item) => item.move.txHash === watch);
          if (watch && current && confirmRef.current) noteRef.current(current.view.step, current.view.message);
        } catch {
          /* keep the last Stargate cards */
        }
        try {
          const tracked = await loadBtcProgress(eth);
          if (cancel) return;
          setBtcCards(tracked.cards);
          const watch = trackingBtc.current;
          for (const item of tracked.finished) {
            const watching = watch === item.id || watch === item.txHash;
            if (watching) trackingBtc.current = null;
            reportFinish(item, watching);
          }
          const current = tracked.cards.find((card) => card.id === trackingBtc.current || card.txHash === trackingBtc.current);
          if (trackingBtc.current && current && confirmRef.current) noteRef.current(current.step, current.message);
        } catch {
          /* keep the last Bitcoin cards */
        }
        try {
          const tracked = await loadEthProgress(eth);
          if (cancel) return;
          setEthCards(tracked.cards);
          const watch = trackingEth.current;
          for (const item of tracked.finished) {
            const watching = watch === item.id || watch === item.txHash;
            if (watching) trackingEth.current = null;
            reportFinish(item, watching);
          }
          const current = tracked.cards.find((card) => card.id === trackingEth.current || card.txHash === trackingEth.current);
          if (trackingEth.current && current && confirmRef.current) {
            if (current.failed) {
              trackingEth.current = null;
              reportFinish({
                id: current.id,
                txHash: current.txHash,
                step: current.step,
                message: current.message,
                ok: false,
                announce: true,
              }, true);
            } else {
              noteRef.current(current.step, current.message);
            }
          }
        } catch {
          /* keep the last ETH cards */
        }
      }
      if (sol || btc) {
        try {
          const tracked = await loadLifiProgress(sol, btc);
          if (cancel) return;
          setLifiCards(tracked.cards);
          const watch = trackingLifi.current;
          for (const item of tracked.finished) {
            const watching = watch === item.id || watch === item.txHash;
            if (watching) trackingLifi.current = null;
            reportFinish(item, watching);
          }
          const current = tracked.cards.find((card) => card.id === trackingLifi.current || card.txHash === trackingLifi.current);
          if (trackingLifi.current && current && confirmRef.current) noteRef.current(current.step, current.message);
        } catch {
          /* keep the last LI.FI cards */
        }
      }
    };
    reloadRef.current = run;
    void run();
    const timer = window.setInterval(() => { void run(); }, 15_000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [eth, btc, sol]);

  const tokens = chain === "bitcoin" ? [] : defaultsFor(chain === "solana" ? "solana" : chain);
  const tunnelChoices: [string, string][] =
    chain === "ethereum"
      ? [["hemi", "Hemi"], ["solana", "Solana"]]
      : chain === "hemi"
        ? [["btc", "Bitcoin"], ["eth", "ETH"]]
        : chain === "solana"
          ? [["bitcoin", "Bitcoin"], ["ethereum", "Ethereum"]]
          : [["hemi", "Hemi"]];
  const activeTarget = target || tunnelChoices[0][0];
  const jupTunnel = mode === "tunnel" && (
    (chain === "solana" && activeTarget === "ethereum") ||
    (chain === "ethereum" && activeTarget === "solana")
  );
  const ethBridge = useMemo(() => bridgeAssets("ethereum").map(bridgeRow), []);
  const solBridge = useMemo(() => bridgeAssets("solana").map(bridgeRow), []);
  const jupPair = jupTunnel
    ? jupTunnelPair({
      page: chain === "solana" ? "solana" : "ethereum",
      payId,
      receiveId,
      ethereum: ethBridge,
      solana: solBridge,
    })
    : null;
  const pay = jupPair?.pay ?? (tokens.find((token) => token.id === payId) ?? tokens[0]);
  const receive = jupPair?.receive ?? counterpartToken(tokens, pay, receiveId, chain);

  useEffect(() => {
    releaseSheet();
    setDirection("deposit");
    setAmount("");
    setDraft(null);
    setError("");
    setTarget("");
    if (chain === "hemi") setVenue("stargate");
  }, [chain]);

  useEffect(() => {
    let alive = true;
    setAvailable(null);
    async function loadPayBalance(): Promise<{ raw: bigint; decimals: number } | null> {
      const btcTunnel = chain === "bitcoin" || (chain === "hemi" && mode === "tunnel" && activeTarget !== "eth");
      if (btcTunnel) {
        if (direction === "withdraw") {
          if (!eth) return null;
          return { raw: await fetchHemiBtcBalance(eth), decimals: 8 };
        }
        if (!btc) return null;
        return { raw: await fetchBtcBalance(btc), decimals: 8 };
      }
      const ethTunnel =
        (chain === "ethereum" && mode === "tunnel" && activeTarget !== "solana") ||
        (chain === "hemi" && mode === "tunnel") ||
        (chain === "hemi" && mode === "swap" && venue === "stargate");
      if (ethTunnel) {
        if (!eth) return null;
        const fromHemi = direction === "withdraw";
        return {
          raw: fromHemi ? await fetchHemiBalance(eth) : await readL1Eth(eth),
          decimals: 18,
        };
      }
      if (payId === "bridge:eth") {
        if (!eth) return null;
        return { raw: await readL1Eth(eth), decimals: 18 };
      }
      if (!pay) return null;
      const owner = pay.network === "solana" ? sol : eth;
      if (!owner) return null;
      return { raw: await readOneBalance(pay.network, owner, pay), decimals: pay.decimals };
    }
    void loadPayBalance().then((row) => {
      if (alive) setAvailable(row);
    }).catch(() => {
      if (alive) setAvailable(null);
    });
    return () => {
      alive = false;
    };
  }, [chain, mode, venue, activeTarget, direction, payId, pay, eth, btc, sol]);

  useEffect(() => {
    setDraft(null);
    if (!accounts || !amount.trim()) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        setQuoting(true);
        setError("");
        try {
          const next = await buildDraft();
          if (alive) setDraft(next);
        } catch (err) {
          if (alive) {
            setDraft(null);
            setError(explainChainError(err));
          }
        } finally {
          if (alive) setQuoting(false);
        }
      })();
    }, 450);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // buildDraft closes over the form fields listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, payId, receiveId, mode, venue, target, direction, slippage, chain, eth, btc, sol]);

  async function buildDraft(): Promise<Draft> {
    if (chain === "bitcoin" || (chain === "hemi" && mode === "tunnel" && activeTarget === "btc")) {
      const way = direction === "withdraw" ? "to-bitcoin" : "to-hemi";
      return { kind: "btc", direction: way, amount: amount.trim(), text: way === "to-hemi" ? "Deposit BTC into the Hemi vault" : "Withdraw hemiBTC to Bitcoin" };
    }
    if ((chain === "ethereum" && mode === "tunnel" && activeTarget === "hemi") || (chain === "hemi" && mode === "tunnel" && activeTarget === "eth")) {
      const way = direction === "withdraw" ? "withdraw" : "deposit";
      return {
        kind: "eth",
        direction: way,
        amount: parseUnits(amount.trim(), 18, "ETH"),
        text: way === "deposit" ? "Deposit ETH to Hemi" : "Withdraw ETH to Ethereum",
      };
    }
    if (chain === "hemi" && mode === "swap" && venue === "stargate") {
      const way = direction === "withdraw" ? "to-ethereum" : "to-hemi";
      const quote = await quoteStargate(way, eth, parseUnits(amount.trim(), 18, "ETH"));
      return { kind: "stargate", quote, text: `${formatUnits(quote.amountOut, 18)} ETH via Stargate` };
    }
    if (chain === "ethereum" && mode === "swap") {
      if (!pay || !receive) throw new Error("Choose two assets.");
      const quote = await quoteSushiPair(sushiLeg(pay), sushiLeg(receive), parseUnits(amount.trim(), pay.decimals, pay.symbol), slippage);
      return { kind: "sushi", quote, text: `${formatUnits(quote.amountOut, receive.decimals)} ${receive.symbol} on SushiSwap` };
    }
    if (chain === "hemi" && venue === "sushi") {
      if (!pay || !receive) throw new Error("Choose two assets.");
      const quote = await quoteHemiSushiPair(hemiLeg(pay), hemiLeg(receive), parseUnits(amount.trim(), pay.decimals, pay.symbol), slippage, eth);
      return { kind: "hemi-sushi", quote, text: `${formatUnits(quote.amountOut, receive.decimals)} ${receive.symbol} on Hemi Sushi` };
    }
    if (jupPair && pay && receive) {
      const payAsset = bridgeAsset(pay);
      const receiveAsset = bridgeAsset(receive);
      const routes = await quoteJupBridge({
        pay: payAsset,
        receive: receiveAsset,
        amountIn: parseUnits(amount.trim(), payAsset.decimals, payAsset.symbol),
        ethAddress: eth,
        solAddress: sol,
        slippageBps: slippage,
      });
      const route = routes[0];
      return {
        kind: "bridge",
        route,
        text: `${formatBridgeAmount(route.expectedOut, route.receive.decimals)} ${route.receive.symbol} · ${route.label}`,
      };
    }
    if (chain === "solana" && mode === "swap" && (payId === "bridge:eth" || receiveId === "bridge:eth")) {
      return bridgeDraft();
    }
    if (chain === "solana" && mode === "swap") {
      if (!pay || !receive) throw new Error("Choose two assets.");
      const quote = await quoteSwapAssets(solAsset(pay), solAsset(receive), parseUnits(amount.trim(), pay.decimals, pay.symbol), slippage);
      return { kind: "sol", quote, text: `${quote.outText} ${receive.symbol} on Jupiter` };
    }
    const from: LifiAsset = direction === "withdraw" ? "BTC" : "SOL";
    const to: LifiAsset = from === "SOL" ? "BTC" : "SOL";
    const decimals = from === "SOL" ? 9 : 8;
    const amountIn = parseUnits(amount.trim(), decimals, from);
    const routes = await listLifiRoutes({
      from,
      to,
      amountIn,
      fromAddress: from === "SOL" ? sol : btc,
      toAddress: to === "SOL" ? sol : btc,
    });
    const route = routes[0];
    return {
      kind: "lifi",
      route,
      from,
      to,
      amountIn,
      text: `${formatLifi(route.expectedOut, to)} ${to} · ${route.toolLabel} · ${formatLifiWait(route.seconds)}`,
    };
  }

  async function bridgeDraft(): Promise<Draft> {
    const ethSide = bridgeAssets("ethereum");
    const solSide = bridgeAssets("solana");
    let payAsset: JupBridgeAsset = BRIDGE_ETH;
    let receiveAsset: JupBridgeAsset = BRIDGE_SOL;
    if (chain === "solana" && mode === "swap") {
      payAsset = payId === "bridge:eth" ? BRIDGE_ETH : BRIDGE_SOL;
      receiveAsset = payId === "bridge:eth" ? BRIDGE_SOL : BRIDGE_ETH;
    } else if (chain === "solana") {
      payAsset = direction === "withdraw" ? (solSide.find((asset) => asset.symbol === pay?.symbol) ?? BRIDGE_SOL) : (ethSide.find((asset) => asset.symbol === pay?.symbol) ?? BRIDGE_ETH);
      receiveAsset = payAsset.chain === "solana"
        ? (ethSide.find((asset) => asset.symbol === payAsset.symbol) ?? BRIDGE_ETH)
        : (solSide.find((asset) => asset.symbol === payAsset.symbol) ?? BRIDGE_SOL);
    } else {
      payAsset = direction === "withdraw" ? (solSide.find((asset) => asset.symbol === "SOL") ?? BRIDGE_SOL) : (ethSide.find((asset) => asset.symbol === (pay?.symbol ?? "ETH")) ?? BRIDGE_ETH);
      receiveAsset = payAsset.chain === "ethereum"
        ? (solSide.find((asset) => asset.symbol === (payAsset.symbol === "ETH" ? "SOL" : payAsset.symbol)) ?? BRIDGE_SOL)
        : (ethSide.find((asset) => asset.symbol === "ETH") ?? BRIDGE_ETH);
    }
    const routes = await quoteJupBridge({
      pay: payAsset,
      receive: receiveAsset,
      amountIn: parseUnits(amount.trim(), payAsset.decimals, payAsset.symbol),
      ethAddress: eth,
      solAddress: sol,
      slippageBps: slippage,
    });
    const route = routes[0];
    return {
      kind: "bridge",
      route,
      text: `${formatBridgeAmount(route.expectedOut, route.receive.decimals)} ${route.receive.symbol} · ${route.label}`,
    };
  }

  const submit = async () => {
    if (!draft || !accounts) return;
    flow.begin("Submitting…");
    let submitted = false;
    try {
      if (draft.kind === "sushi") {
        flow.setStep("Sending the swap…");
        const sent = await executeSushiPair(draft.quote, (text) => flow.setStep(text));
        submitted = true;
        flow.finish(true, "Swapped", `${draft.quote.pay.symbol} for ${draft.quote.receive.symbol} is confirmed. ${sent.hash.slice(0, 12)}…`);
        return;
      }
      if (draft.kind === "hemi-sushi") {
        flow.setStep("Waiting for Hemi to confirm…");
        const hash = await executeHemiSushi(draft.quote, eth);
        submitted = true;
        flow.finish(true, "Swapped", `${draft.quote.pay.symbol} for ${draft.quote.receive.symbol} is confirmed on Hemi. ${hash.slice(0, 12)}…`);
        return;
      }
      if (draft.kind === "stargate") {
        const from = draft.quote.direction === "to-hemi" ? "Ethereum" : "Hemi";
        flow.setStep(`Step 1 of 3 · Sending on ${from}`);
        const hash = await executeStargate(draft.quote, eth);
        const move: StargateMove = {
          id: hash,
          direction: draft.quote.direction,
          createdAt: Date.now(),
          amountIn: draft.quote.amountIn.toString(),
          amountOut: draft.quote.amountOut.toString(),
          address: eth,
          txHash: hash,
          status: "inflight",
        };
        trackingStargate.current = hash;
        const first = stargateStep(move.direction, { indexed: false, name: "", source: "", destination: "" });
        holdOrToast(first.step, first.message);
        submitted = true;
        try {
          await saveStargateMove(move);
          void reloadRef.current();
        } catch {
          setError("The ETH was sent. This device could not save the tracker.");
        }
        return;
      }
      if (draft.kind === "sol") {
        flow.setStep("Waiting for Solana to confirm…");
        const sent = await executeSwap(sol, draft.quote.raw);
        submitted = true;
        flow.finish(true, "Swapped", `Jupiter confirmed the swap. ${sent.signature.slice(0, 12)}…`);
        return;
      }
      if (draft.kind === "bridge") {
        const hash = await executeJupBridge(draft.route, eth, sol);
        submitted = true;
        flow.finish(true, "Bridge sent", `${draft.route.label}. ${hash.slice(0, 12)}…`);
        return;
      }
      if (draft.kind === "lifi") {
        const fresh = await quoteLifiSwap({
          from: draft.from,
          to: draft.to,
          amountIn: draft.amountIn,
          fromAddress: draft.from === "SOL" ? sol : btc,
          toAddress: draft.to === "SOL" ? sol : btc,
          tool: draft.route.tool,
        });
        if (fresh.minOut < draft.route.minOut) throw new Error("The quote moved. Review it again.");
        const hash = await executeLifiSwap(fresh, draft.from === "SOL" ? sol : btc);
        trackingLifi.current = hash;
        const tracked = lifiStep(null, fresh.toolLabel);
        holdOrToast(tracked.step, `${fresh.toolLabel} pays the other chain after it sees this transaction.`);
        submitted = true;
        try {
          await saveLifiMove({
            id: hash,
            direction: draft.from === "SOL" ? "sol-to-btc" : "btc-to-sol",
            createdAt: Date.now(),
            amountIn: draft.amountIn.toString(),
            expectedOut: fresh.expectedOut.toString(),
            from: draft.from === "SOL" ? sol : btc,
            to: draft.to === "SOL" ? sol : btc,
            txHash: hash,
            tool: fresh.tool,
            toolLabel: fresh.toolLabel,
            fromChain: draft.from === "SOL" ? "sol" : "btc",
            toChain: draft.to === "SOL" ? "sol" : "btc",
            status: "submitted",
          });
          void reloadRef.current();
        } catch {
          setError("The swap was sent. This device could not save the tracker.");
        }
        return;
      }
      if (draft.kind === "btc") {
        if (draft.direction === "to-hemi") {
          flow.setStep("Step 1 of 3 · Broadcasting the Bitcoin deposit");
          const sent = await depositToHemi(eth, draft.amount);
          trackingBtc.current = sent.txid;
          holdOrToast(
            "Step 2 of 3 · Bitcoin confirmations",
            "The deposit is in Bitcoin's mempool. This screen follows it until you can mint hemiBTC.",
          );
        } else {
          flow.setStep("Step 1 of 2 · Sending the withdrawal on Hemi");
          const sent = await withdrawToBitcoin(btc, draft.amount, eth);
          trackingBtc.current = sent.hash;
          holdOrToast(
            "Step 1 of 2 · Hemi inclusion",
            "The withdrawal is on Hemi. This screen follows it until Bitcoin pays out.",
          );
        }
        submitted = true;
        void reloadRef.current();
        return;
      }
      if (draft.direction === "deposit") {
        flow.setStep("Step 1 of 2 · Broadcasting the Ethereum deposit");
        const hash = await depositEth(eth, eth, draft.amount);
        let hemiWeiBefore: string | undefined;
        try {
          hemiWeiBefore = (await fetchHemiBalance(eth)).toString();
        } catch {
          hemiWeiBefore = undefined;
        }
        trackingEth.current = hash;
        holdOrToast(
          "Step 1 of 2 · Waiting for Ethereum",
          "The deposit is in the Ethereum mempool. This screen follows it until Hemi credits the ETH.",
        );
        submitted = true;
        try {
          await saveEthMove({
            id: hash,
            direction: "to-hemi",
            createdAt: Date.now(),
            amountWei: draft.amount.toString(),
            from: eth,
            to: eth,
            txHash: hash,
            hemiWeiBefore,
            status: "submitted",
          });
          void reloadRef.current();
        } catch {
          setError("The ETH was sent. This device could not save the tracker.");
        }
      } else {
        flow.setStep("Step 1 of 4 · Sending the withdrawal on Hemi");
        const sent = await withdrawEth(eth, eth, draft.amount);
        trackingEth.current = sent.hash;
        holdOrToast(
          "Step 1 of 4 · Waiting for a Hemi output",
          "The withdrawal is on Hemi. This screen follows it through the proof, the 24 hour wait, and finalize.",
        );
        submitted = true;
        try {
          await saveEthMove({
            id: sent.hash,
            direction: "to-ethereum",
            createdAt: Date.now(),
            amountWei: draft.amount.toString(),
            from: eth,
            to: eth,
            txHash: sent.hash,
            l2Block: sent.l2Block,
            withdrawal: storedWithdrawal(sent.withdrawal, sent.withdrawalHash),
            status: "submitted",
          });
          void reloadRef.current();
        } catch {
          setError("The withdrawal was sent. This device could not save the tracker.");
        }
      }
    } catch (err) {
      if (!submitted) flow.finish(false, "Could not finish", explainChainError(err));
    }
  };

  const continueEth = async (move: EthMove) => {
    const fields = withdrawalFields(move);
    if (!fields || move.l2Block == null) {
      setError("This deposit does not need a second signature.");
      return;
    }
    flow.begin("Checking the withdrawal…");
    setOpen(true);
    try {
      const stage = await readWithdrawalStage(fields, move.l2Block);
      if (stage.kind === "ready-to-prove") {
        flow.setStep("Proving the withdrawal on Ethereum…");
        const hash = await proveWithdrawal(fields, stage.output);
        await markEthMove(move.id, "proven");
        flow.finish(true, "Proof sent", hash.slice(0, 18));
      } else if (stage.kind === "ready-to-finalize") {
        flow.setStep("Finalizing the withdrawal on Ethereum…");
        const hash = await finalizeWithdrawal(fields);
        await markEthMove(move.id, "finalized");
        told.current.add(`${move.id}:ok`);
        flow.finish(true, "Finalized", hash.slice(0, 18));
      } else {
        flow.finish(false, "Not ready", stageError(stage));
      }
      void reloadRef.current();
    } catch (err) {
      flow.finish(false, "Tunnel failed", explainChainError(err));
    }
  };

  const mint = async (move: TunnelMove) => {
    flow.begin("Minting hemiBTC…");
    setOpen(true);
    try {
      const sent = await mintHemiDeposit(move);
      told.current.add(`${move.id}:ok`);
      flow.finish(true, sent.already ? "Already minted" : "Mint sent", sent.hash.slice(0, 18));
      void reloadRef.current();
    } catch (err) {
      flow.finish(false, "Mint failed", explainChainError(err));
    }
  };

  if (!accounts) {
    return (
      <div className="container">
        <Header title="Swap" />
        <p className="text-sm text-white/70" role={addressError ? "alert" : "status"}>{phrasePending ? "Loading account addresses…" : addressError || "These networks need the recovery phrase. A private-key import stays on Warthog."}</p>
      </div>
    );
  }

  const showSwap = chain !== "bitcoin";
  const locked = lockedSwapRoute({ chain, mode, venue, target: activeTarget, direction });
  const routed = tunnelEnds({ chain, mode, target: activeTarget, direction });
  const ends = jupPair
    ? {
      payChain: jupPair.pay.network === "ethereum" ? "Ethereum" : "Solana",
      receiveChain: jupPair.receive.network === "ethereum" ? "Ethereum" : "Solana",
      subtitle: `${jupPair.pay.network === "ethereum" ? "Ethereum" : "Solana"} → ${jupPair.receive.network === "ethereum" ? "Ethereum" : "Solana"}`,
    }
    : routed;
  const picks = !locked && showTokenPick();
  const payChoices = picks ? tokenChoices("pay") : undefined;
  const receiveChoices = picks ? tokenChoices("receive") : undefined;
  const paySymbol = locked?.pay.symbol
    || (jupPair ? jupPair.pay.symbol : payChoices?.find((choice) => choice.id === (payId || pay?.id))?.symbol)
    || pay?.symbol
    || "ETH";
  const receiveSymbol = locked?.receive.symbol
    || (jupPair ? jupPair.receive.symbol : receiveChoices?.find((choice) => choice.id === (receiveId || receive?.id))?.symbol)
    || receive?.symbol
    || paySymbol;
  const payMark = locked?.pay.mark ?? (pay ? tokenMark(pay.symbol, pay.network, pay.native) : paySymbol);
  const receiveMark = locked?.receive.mark ?? (receive ? tokenMark(receive.symbol, receive.network, receive.native) : receiveSymbol);
  const subtitle = ends
    ? ends.subtitle
    : locked
      ? locked.subtitle
      : chain === "hemi"
        ? `${paySymbol} → ${receiveSymbol} · Hemi`
        : `${paySymbol} → ${receiveSymbol}`;
  const hint = jupPair
    ? "Jupiter moves ETH, SOL, USDC, and USDT between Ethereum and Solana."
    : locked
    ? locked.hint
    : chain === "hemi" && mode === "swap"
      ? "Sushi swaps the assets you pick on Hemi. This stays on Hemi. It is not a bridge."
      : mode === "swap"
        ? "A market swap. The amount you receive is an estimate until you confirm."
        : "A tunnel moves the same coin to the other network.";
  const usesSlippage =
    (mode === "swap" && chain !== "bitcoin" && !(chain === "hemi" && venue === "stargate")) ||
    (mode === "tunnel" && (
      (chain === "ethereum" && activeTarget === "solana") ||
      (chain === "solana" && activeTarget === "ethereum")
    ));

  return (
    <div className="container space-y-3 pb-8">
      <Header title={CHAIN_LABEL[chain]} />
      {chain === "ethereum" || chain === "hemi" ? <MoveList title="Stargate" rows={stargateCards} /> : null}
      {chain === "bitcoin" || chain === "hemi" ? (
        <MoveList title="Bitcoin tunnel" rows={btcCards} onAction={(row) => { if (row.btc) void mint(row.btc); }} />
      ) : null}
      {chain === "ethereum" || chain === "hemi" ? (
        <MoveList title="ETH tunnel" rows={ethCards} onAction={(row) => { if (row.eth) void continueEth(row.eth); }} />
      ) : null}
      {chain === "solana" || chain === "bitcoin" ? <MoveList title="SOL ↔ BTC" rows={lifiCards} /> : null}
      <SwapStyleCard
        title={mode === "swap" ? "Swap" : "Tunnel"}
        subtitle={subtitle}
        toolbar={(
          <div className="flex flex-wrap items-center gap-2">
            {showSwap ? (
              <button type="button" className={mode === "swap" ? chipOn : chip} onClick={() => selectRoute({ mode: "swap" })}>Swap</button>
            ) : null}
            <button type="button" className={mode === "tunnel" ? chipOn : chip} onClick={() => selectRoute({ mode: "tunnel" })}>Tunnel</button>
            {mode === "tunnel"
              ? tunnelChoices.length === 1
                ? <span className={chipOn}>To {ends?.receiveChain ?? tunnelChoices[0][1]}</span>
                : tunnelChoices.map(([id, label]) => (
                  <button key={id} type="button" className={activeTarget === id ? chipOn : chip} onClick={() => selectRoute({ target: id })}>{label}</button>
                ))
              : null}
            {chain === "hemi" && mode === "swap" ? (
              <>
                <button type="button" className={venue === "stargate" ? chipOn : chip} onClick={() => selectRoute({ venue: "stargate" })}>Stargate</button>
                <button type="button" className={venue === "sushi" ? chipOn : chip} onClick={() => selectRoute({ venue: "sushi" })}>Sushi</button>
              </>
            ) : null}
          </div>
        )}
        payHint={available ? <>Available <span className="bal-color tabular-nums">{formatUnits(available.raw, available.decimals)}</span> {paySymbol}{locked && !ends ? ` · ${locked.payNetwork}` : ""}</> : "Available …"}
        onMax={available && available.raw > 0n ? () => setAmount(formatUnits(available.raw, available.decimals)) : undefined}
        amount={amount}
        onAmount={setAmount}
        paySymbol={paySymbol}
        payMark={payMark}
        payChain={ends?.payChain}
        payChoices={payChoices}
        payValue={jupPair ? jupPair.pay.id : (payId || pay?.id || "")}
        onPay={picks ? setPayId : undefined}
        receiveHint={ends ? undefined : locked ? locked.receiveNetwork : usesSlippage ? `Estimate · ${slippage / 100}% slip` : "Estimate"}
        receiveAmount={quoting ? "…" : receiveFigure()}
        receiveSymbol={receiveSymbol}
        receiveMark={receiveMark}
        receiveChain={ends?.receiveChain}
        receiveChoices={receiveChoices}
        receiveValue={jupPair ? jupPair.receive.id : (receiveId || receive?.id || "")}
        onReceive={picks ? setReceiveId : undefined}
        onFlip={flipLegs}
        extra={usesSlippage ? (
          <div className="flex gap-2">
            {[50, 100, 300].map((bps) => (
              <button key={bps} type="button" className={slippage === bps ? chipOn : chip} onClick={() => setSlippage(bps)}>
                {bps / 100}%
              </button>
            ))}
          </div>
        ) : null}
        summary={(
          <>
            <div className="flex justify-between gap-3">
              <span>Route</span>
              <span className="text-zinc-400 text-right">{draft?.text || (quoting ? "Quoting…" : "Enter an amount")}</span>
            </div>
            {draft?.kind === "stargate" ? (
              <div className="flex justify-between gap-3">
                <span>Message fee</span>
                <span className="text-zinc-400">{formatUnits(draft.quote.fee, 18)} ETH</span>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <span>Network</span>
              <span className="text-zinc-400">{ends ? ends.subtitle : CHAIN_LABEL[chain]}</span>
            </div>
          </>
        )}
        error={error}
        hint={hint}
        cta={mode === "swap" ? "Review swap" : "Review tunnel"}
        ctaDisabled={!draft || quoting || flow.busy}
        onCta={() => setOpen(true)}
      />

      <SpendConfirm
        open={open}
        title={mode === "swap" ? "Confirm swap" : "Confirm tunnel"}
        rows={[
          { label: "You pay", value: `${amount.trim() || "—"} ${paySymbol}${ends ? ` · ${ends.payChain}` : locked ? ` · ${locked.payNetwork}` : ""}` },
          { label: "You receive", value: ends ? `${receiveFigure()} ${receiveSymbol} · ${ends.receiveChain}` : locked ? `${receiveFigure()} ${receiveSymbol} · ${locked.receiveNetwork}` : (draft?.text || "—") },
          { label: "Network", value: ends ? ends.subtitle : CHAIN_LABEL[chain] },
        ]}
        confirmLabel={mode === "swap" ? "Confirm and swap" : "Confirm and send"}
        busy={flow.busy}
        step={flow.step}
        outcome={flow.outcome}
        onCancel={() => {
          releaseSheet(() => setAmount(""));
          setDraft(null);
        }}
        onConfirm={() => { void submit(); }}
      />
    </div>
  );

  function selectRoute(patch: { mode?: "swap" | "tunnel"; venue?: "stargate" | "sushi"; target?: string }) {
    const nextMode = patch.mode ?? mode;
    const nextVenue = patch.venue ?? venue;
    const targetChanged = patch.target != null && patch.target !== activeTarget;
    const changed = nextMode !== mode || nextVenue !== venue || targetChanged;
    if (patch.mode && patch.mode !== mode) setTarget("");
    if (patch.mode) setMode(patch.mode);
    if (patch.venue) setVenue(patch.venue);
    if (patch.target) setTarget(patch.target);
    if (!changed) return;
    releaseSheet();
    setDirection("deposit");
    setAmount("");
    setDraft(null);
    setError("");
  }

  function showTokenPick(): boolean {
    if (mode === "tunnel") {
      if (chain === "ethereum" && activeTarget === "solana") return true;
      if (chain === "solana" && activeTarget === "ethereum") return true;
      return false;
    }
    if (chain === "hemi" && venue === "stargate") return false;
    return chain === "ethereum" || chain === "hemi" || chain === "solana";
  }

  function tokenChoices(role: "pay" | "receive") {
    if (jupPair) {
      const list = role === "pay"
        ? (jupPair.pay.network === "ethereum" ? ethBridge : solBridge)
        : (jupPair.receive.network === "ethereum" ? ethBridge : solBridge);
      return list.map((token) => ({
        id: token.id,
        symbol: token.symbol,
        mark: tokenMark(token.symbol, token.network, token.native),
      }));
    }
    const list = [...tokens];
    if (chain === "solana" && mode === "swap") {
      list.unshift({
        id: "bridge:eth",
        network: "solana",
        symbol: "ETH",
        name: "Ether on Ethereum",
        decimals: 18,
        address: "native",
        native: true,
      });
    }
    return list
      .filter((token) => role === "pay" || token.id !== (pay?.id ?? ""))
      .map((token) => ({
        id: token.id,
        symbol: token.symbol,
        mark: tokenMark(token.symbol, token.network, token.native),
      }));
  }

  function flipLegs() {
    if (jupPair && pay && receive) {
      setPayId(receive.id);
      setReceiveId(pay.id);
      setAmount("");
      setDraft(null);
      setError("");
      return;
    }
    if (locked) {
      setDirection((current) => (current === "withdraw" ? "deposit" : "withdraw"));
      setAmount("");
      setDraft(null);
      setError("");
      return;
    }
    if (payId === "bridge:eth" || receiveId === "bridge:eth") {
      const nextPay = payId === "bridge:eth" ? (receive?.id || "") : "bridge:eth";
      const nextReceive = receiveId === "bridge:eth" ? payId : "bridge:eth";
      setPayId(nextPay);
      setReceiveId(nextReceive);
      return;
    }
    if (picks && pay && receive) {
      setPayId(receive.id);
      setReceiveId(pay.id);
      return;
    }
    setDirection((current) => (current === "withdraw" ? "deposit" : "withdraw"));
  }

  function receiveFigure(): string {
    if (!draft) return "0";
    if (draft.kind === "sushi" || draft.kind === "hemi-sushi") {
      return formatUnits(draft.quote.amountOut, receive?.decimals ?? draft.quote.receive.decimals);
    }
    if (draft.kind === "stargate") return formatUnits(draft.quote.amountOut, 18);
    if (draft.kind === "sol") return draft.quote.outText;
    if (draft.kind === "bridge") return formatBridgeAmount(draft.route.expectedOut, draft.route.receive.decimals);
    if (draft.kind === "lifi") return formatLifi(draft.route.expectedOut, draft.to);
    return amount.trim() || "0";
  }
}

function MoveList({
  title,
  rows,
  onAction,
}: {
  title: string;
  rows: MoveCard[];
  onAction?: (row: MoveCard) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-white/10 p-3">
      <p className="mb-2 text-xs uppercase tracking-wide text-white/40">{title}</p>
      <div className="space-y-3">
        {rows.slice(0, 5).map((row) => (
          <div key={row.id} className="space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-white">{row.title}</p>
                <p className="text-[11px] text-white/45">{row.meta}</p>
              </div>
              {row.action ? (
                <button type="button" className="text-xs text-primary" onClick={() => onAction?.(row)}>{row.action}</button>
              ) : null}
            </div>
            <div className="flex items-start gap-2">
              {row.spinning ? (
                <div className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              ) : (
                <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${row.failed ? "bg-red-400" : "bg-emerald-400"}`} />
              )}
              <div className="min-w-0">
                <p className="text-xs text-white/90">{row.step}</p>
                <p className="text-[11px] text-white/55">{row.message}</p>
              </div>
            </div>
            <a className="text-xs text-primary" href={row.href} target="_blank" rel="noreferrer">{row.link}</a>
          </div>
        ))}
      </div>
    </div>
  );
}
