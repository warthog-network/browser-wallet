import { useEffect, useMemo, useRef, useState } from "react";
import safetradeMark from "../assets/safetrade-favicon.png";
import { Address, NonceId, RoundedFee, Wart, type TransactionJson } from "warthog-ts";
import ForwarderCard from "../components/ForwarderCard";
import Header from "../components/Header";
import NetworkBadge from "../components/chains/NetworkBadge";
import SpendConfirm, { useSpendFlow } from "../components/SpendConfirm";
import NodeError from "../components/NodeError";
import SwapStyleCard from "../components/SwapStyleCard";
import TickerMenu from "../components/TickerMenu";
import useWallet from "../hooks/useWallet";
import { createTransactionContext, submitTransaction } from "../utils";
import { amountExceedsAvailable, insufficientFreeBalanceMessage } from "../utils/balanceBreakdown";
import { nodeForFamily } from "../utils/nodes";
import { fetchBalanceAndPin } from "../utils/warthogNode";
import { signPreparedWarthog } from "../utils/signingBridge";
import { DEFAULT_TX_FEE } from "../config/network";
import { sendEthAsset } from "../mobile-port/utils/ethChain";
import { ETH_USDC, ETH_USDT } from "../mobile-port/utils/ethTokens";
import { explainExchangeFailure } from "../mobile-port/utils/exchange/http";
import {
  SAFE_ROUTES,
  clearSafeTradeCredentials,
  keyHint,
  loadSafeTradeCredentials,
  safeBalances,
  safeCancelOrder,
  safeDepositAddress,
  safeDepth,
  safeLimitOrder,
  safeOpenOrders,
  safePair,
  safePublicNetwork,
  safeSlippagePrice,
  safeSwap,
  safeTicker,
  safeWaitOrder,
  safeWithdrawCoin,
  saveSafeTradeCredentials,
  walkBook,
  type BookFill,
  type SafeDepth,
  type SafeMarket,
  type SafeOrder,
  type SafeRoute,
  type SafeTradeCredentials,
  type SpotBalance,
} from "../mobile-port/utils/exchange/safetrade";
import { fetchBtcBalance, formatBtc, maxSendableBtc, sendBtc } from "../mobile-port/utils/networks/btc";
import { USDC_MINT, USDT_MINT } from "../mobile-port/utils/networks/chains";
import { fetchSolBalance, formatSol, maxSolPayment, sendSol } from "../mobile-port/utils/networks/solana";
import { sendSpl } from "../mobile-port/utils/networks/solswap";
import { formatUnits } from "../mobile-port/utils/networks/units";
import { readOneBalance } from "../mobile-port/utils/tokenBalances";
import type { WalletNode } from "../config/network";
import { useChainAccounts } from "../chains/useChainAccounts";

const field = "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-primary";
const chip = "swap-chip-btn";
const chipOn = "swap-chip-btn swap-chip-btn--active";

const SLIPPAGE: { bps: number | null; label: string }[] = [
  { bps: null, label: "Off" },
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 300, label: "3%" },
  { bps: 1500, label: "15%" },
];

const BOOK_ROWS = 8;

const NETWORKS = ["Warthog", "Ethereum", "Bitcoin", "Solana"] as const;

function floorText(value: number, places: number): string {
  const factor = 10 ** places;
  const floored = Math.floor(value * factor + 1e-9) / factor;
  return String(floored);
}

function formatBook(value: number, places: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(Math.min(8, Math.max(places, 0)));
  const [whole, frac = ""] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function formatChange(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (text.includes("%")) return text;
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return `${n > 0 ? "+" : ""}${text}%`;
}

function slippageVersus(fill: BookFill): string {
  return fill.referenceIsLast ? "the last price" : "the top of the book";
}

function slippagePercent(fill: BookFill): string {
  const pct = (Math.abs(fill.slippageBps) / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  if (fill.slippageBps > 0) return `${pct}% worse than ${slippageVersus(fill)}`;
  if (fill.slippageBps < 0) return `${pct}% better than ${slippageVersus(fill)}`;
  return `0% vs ${slippageVersus(fill)}`;
}

function slippageAmountText(fill: BookFill, quote: string, places: number): string {
  const amount = `${formatBook(Math.abs(fill.slippageQuote), places)} ${quote}`;
  if (Math.abs(fill.slippageQuote) < 1e-12) return `0 ${quote}`;
  return fill.slippageQuote > 0 ? `${amount} worse than ${slippageVersus(fill)}` : `${amount} better than ${slippageVersus(fill)}`;
}

function coverageText(
  fill: BookFill,
  base: string,
  quote: string,
  amountPlaces: number,
  totalPlaces: number,
): string {
  const sized = `${floorText(fill.base, amountPlaces)} ${base} (${floorText(fill.quote, totalPlaces)} ${quote})`;
  if (fill.complete) return `Covers this order · ${sized}`;
  if (fill.shortBook) return `The loaded book ends before this order is covered. Priced ${sized}. The rest can fill at any price.`;
  return `The book covers ${sized}. The rest may not fill.`;
}

function routesOn(network: string): SafeRoute[] {
  return SAFE_ROUTES.filter((route) => route.network === network);
}

function routeForCurrency(currency: string, preferNetwork: string): SafeRoute | undefined {
  const rows = SAFE_ROUTES.filter((route) => route.currency === currency);
  return rows.find((route) => route.network === preferNetwork) ?? rows[0];
}

/** One row per currency that has a direct SafeTrade market with `currency`. */
function marketPartners(currency: string, preferNetwork: string): SafeRoute[] {
  const seen = new Set<string>();
  const out: SafeRoute[] = [];
  for (const row of SAFE_ROUTES) {
    if (row.currency === currency || seen.has(row.currency)) continue;
    if (!safePair(currency, row.currency)) continue;
    const pick = routeForCurrency(row.currency, preferNetwork);
    if (!pick) continue;
    seen.add(row.currency);
    out.push(pick);
  }
  return out;
}

function trimAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatBalance(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(8).replace(/\.?0+$/, "");
  return text || "0";
}

function balanceLine(rows: SpotBalance[], asset: string): string {
  const row = rows.find((item) => item.asset === asset);
  if (!row) return "0 free";
  const free = formatBalance(row.available);
  if (row.locked > 0) return `${free} free · ${formatBalance(row.locked)} locked`;
  return `${free} free`;
}

function freeLockedMessage(symbol: string, available: number, locked: number): string {
  if (locked > 0) {
    return `Only ${formatBalance(available)} ${symbol} free; ${formatBalance(locked)} locked in open orders.`;
  }
  return `Only ${formatBalance(available)} ${symbol} is free on SafeTrade.`;
}

type WalletHold = { text: string; max: string; failed: boolean };

/** On-chain amount this wallet can spend. Same read the swap panel uses. */
async function walletHold(
  route: SafeRoute,
  owners: { wart: string; eth: string; btc: string; sol: string },
  node: WalletNode | null | undefined,
): Promise<WalletHold> {
  if (route.chain === "wart") {
    if (!owners.wart || !node) return { text: "0", max: "", failed: false };
    const live = await fetchBalanceAndPin(node, owners.wart);
    const free = Number(live.available);
    const fee = Number(DEFAULT_TX_FEE);
    const max = Number.isFinite(free) && free > fee ? trimAmount(free - fee) : "";
    return { text: live.available || "0", max, failed: false };
  }
  if (route.chain === "bitcoin") {
    if (!owners.btc) return { text: "0", max: "", failed: false };
    const [balance, max] = await Promise.all([
      fetchBtcBalance(owners.btc),
      maxSendableBtc(owners.btc),
    ]);
    return { text: formatBtc(balance), max: max > 0n ? formatBtc(max) : "", failed: false };
  }
  if (route.chain === "solana") {
    if (!owners.sol) return { text: "0", max: "", failed: false };
    if (route.currency === "sol") {
      const [balance, max] = await Promise.all([
        fetchSolBalance(owners.sol),
        maxSolPayment(owners.sol),
      ]);
      return { text: formatSol(balance), max: max > 0n ? formatSol(max) : "", failed: false };
    }
    const mint = route.currency === "usdc" ? USDC_MINT : USDT_MINT;
    const raw = await readOneBalance("solana", owners.sol, { native: false, address: mint });
    const text = formatUnits(raw, route.decimals);
    return { text, max: raw > 0n ? text : "", failed: false };
  }
  if (!owners.eth) return { text: "0", max: "", failed: false };
  if (route.currency === "eth") {
    const raw = await readOneBalance("ethereum", owners.eth, { native: true, address: "native" });
    const text = formatUnits(raw, 18);
    return { text, max: raw > 0n ? text : "", failed: false };
  }
  const token = route.currency === "usdc" ? ETH_USDC : ETH_USDT;
  const raw = await readOneBalance("ethereum", owners.eth, { native: false, address: token });
  const text = formatUnits(raw, route.decimals);
  return { text, max: raw > 0n ? text : "", failed: false };
}

export default function SafeTradePage() {
  const wallet = useWallet();
  const { accounts } = useChainAccounts();
  const flow = useSpendFlow();
  const [creds, setCreds] = useState<SafeTradeCredentials | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [panel, setPanel] = useState<"swap" | "limit" | "move">("swap");
  const [network, setNetwork] = useState<(typeof NETWORKS)[number]>("Ethereum");
  const [payId, setPayId] = useState("usdt:erc20_key");
  const [receiveId, setReceiveId] = useState("wart:wart-key");
  const [moveDir, setMoveDir] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [orders, setOrders] = useState<SafeOrder[]>([]);
  const [emailCode, setEmailCode] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SpotBalance[] | null>(null);
  const [walletHolds, setWalletHolds] = useState<Record<string, WalletHold>>({});
  const [checkError, setCheckError] = useState("");
  const [checking, setChecking] = useState(false);
  const [price, setPrice] = useState(0);
  const [lastText, setLastText] = useState("");
  const [change, setChange] = useState("");
  const [slippageBps, setSlippageBps] = useState<number | null>(100);
  const [depth, setDepth] = useState<SafeDepth | null>(null);
  const [depthError, setDepthError] = useState("");
  const [depthBusy, setDepthBusy] = useState(false);
  const [reviewFill, setReviewFill] = useState<BookFill | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const depthRef = useRef<SafeDepth | null>(null);
  const depthMarket = useRef("");

  const balanceOf = (symbol: string): SpotBalance | undefined =>
    rows?.find((row) => row.asset === symbol);

  // SafeTrade buys on the Warthog mainnet. There is no Warthog testnet
  // for it, so it always uses the mainnet node, whichever family the
  // wallet is currently on.
  const mainnetNode = nodeForFamily(
    wallet.nodeList,
    "mainnet",
    wallet.selectedNodeUrls,
  );
  const mainnetIndex = mainnetNode
    ? wallet.nodeList.findIndex((n) => n.url === mainnetNode.url)
    : -1;
  // Whether there is a mainnet node to pick, or none at all.
  const mainnetAnyNode = wallet.nodeList.some((n) => n.network === "mainnet");
  const mainnetReason = mainnetAnyNode
    ? "No mainnet node selected. SafeTrade buys on the Warthog mainnet, and there is no Warthog testnet for it."
    : "No mainnet node configured. SafeTrade buys on the Warthog mainnet, and there is no Warthog testnet for it.";
  const pay = SAFE_ROUTES.find((route) => route.id === payId) ?? routesOn(network)[0];
  const trading = panel === "swap" || panel === "limit";
  const receiveChoices = useMemo(() => {
    if (!trading || !pay) return routesOn(network);
    return marketPartners(pay.currency, network);
  }, [network, trading, pay]);
  const receive = receiveChoices.find((route) => route.id === receiveId) ?? receiveChoices.find((route) => route.id !== pay?.id) ?? receiveChoices[0];
  const pair = pay && receive ? safePair(pay.currency, receive.currency) : null;
  // The badge is a label here, not a switch: SafeTrade is always on the
  // Warthog mainnet.

  useEffect(() => {
    void loadSafeTradeCredentials().then(setCreds);
  }, []);

  useEffect(() => {
    if (!trading || !pay) return;
    const partners = marketPartners(pay.currency, network);
    if (!partners.some((route) => route.id === receiveId)) {
      const next = partners[0];
      if (next) setReceiveId(next.id);
    }
  }, [trading, pay, network, receiveId]);

  const marketId = pair?.market.id ?? "";
  const seenMarket = useRef(marketId);
  useEffect(() => {
    if (!marketId || seenMarket.current === marketId) return;
    seenMarket.current = marketId;
    setLimitPrice("");
  }, [marketId]);

  useEffect(() => {
    if (!trading || !marketId) {
      setPrice(0);
      setLastText("");
      setChange("");
      return undefined;
    }
    let alive = true;
    void safeTicker(marketId).then((ticker) => {
      if (!alive) return;
      const last = Number(ticker.last) || 0;
      setPrice(last);
      setLastText(ticker.last);
      setChange(ticker.change);
    }).catch(() => {
      if (!alive) return;
      setPrice(0);
      setLastText("");
      setChange("");
    });
    return () => {
      alive = false;
    };
  }, [trading, marketId]);

  useEffect(() => {
    if (panel !== "limit" || !(price > 0)) return;
    setLimitPrice((prev) => prev || lastText || String(price));
  }, [panel, price, lastText]);

  useEffect(() => {
    if (!trading || !marketId) {
      depthMarket.current = "";
      depthRef.current = null;
      setDepth(null);
      setDepthError("");
      setDepthBusy(false);
      return undefined;
    }
    let cancel = false;
    const keep = depthMarket.current === marketId && depthRef.current != null;
    depthMarket.current = marketId;
    if (!keep) {
      depthRef.current = null;
      setDepth(null);
      setDepthError("");
    }
    const load = async () => {
      setDepthBusy(true);
      try {
        const next = await safeDepth(marketId);
        if (cancel || depthMarket.current !== marketId) return;
        depthRef.current = next;
        setDepth(next);
        setDepthError("");
      } catch (err) {
        if (cancel || depthMarket.current !== marketId) return;
        if (!depthRef.current) setDepthError(explainExchangeFailure(err));
      } finally {
        if (!cancel && depthMarket.current === marketId) setDepthBusy(false);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 8000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [trading, marketId]);

  useEffect(() => {
    if (panel !== "limit" || !creds || !pair || !rows) {
      setOrders([]);
      return undefined;
    }
    let alive = true;
    const load = () => {
      void safeOpenOrders(creds, pair.market.id)
        .then((rows) => { if (alive) setOrders(rows); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [panel, creds, pair?.market.id, notice, rows]);

  const addressFor = (route: SafeRoute): string => {
    if (route.chain === "wart") return wallet.wallet || "";
    if (route.chain === "ethereum") return accounts?.ethAddress || "";
    if (route.chain === "bitcoin") return accounts?.btcAddress || "";
    return accounts?.solAddress || "";
  };

  useEffect(() => {
    let alive = true;
    const owners = {
      wart: wallet.wallet || "",
      eth: accounts?.ethAddress || "",
      btc: accounts?.btcAddress || "",
      sol: accounts?.solAddress || "",
    };
    void Promise.all(SAFE_ROUTES.map(async (route) => {
      try {
        const hold = await walletHold(route, owners, mainnetNode);
        return [route.id, hold] as const;
      } catch {
        return [route.id, { text: "—", max: "", failed: true }] as const;
      }
    })).then((pairs) => {
      if (alive) setWalletHolds(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [wallet.wallet, accounts?.ethAddress, accounts?.btcAddress, accounts?.solAddress, mainnetNode, notice]);

  const checkBalances = async () => {
    setChecking(true);
    setCheckError("");
    try {
      let next = creds;
      const typedKey = apiKey.trim();
      const typedSecret = secret.trim();
      if (typedKey || typedSecret) {
        if (!typedKey || !typedSecret) {
          throw new Error("Enter both the API key and the secret, then check again.");
        }
        next = { apiKey: typedKey, secret: typedSecret };
        await saveSafeTradeCredentials(next);
        setCreds(next);
        setApiKey("");
        setSecret("");
      }
      if (!next) throw new Error("Save a SafeTrade API key and secret first.");
      setRows(null);
      const balances = await safeBalances(next);
      setRows(balances);
    } catch (err) {
      setRows(null);
      setCheckError(explainExchangeFailure(err));
    } finally {
      setChecking(false);
    }
  };

  const forgetKey = async () => {
    setChecking(true);
    try {
      await clearSafeTradeCredentials();
      setCreds(null);
      setApiKey("");
      setSecret("");
      setRows(null);
      setCheckError("");
    } catch (err) {
      setCheckError(explainExchangeFailure(err));
    } finally {
      setChecking(false);
    }
  };

  const payValue = Number(amount);
  const bookFill = panel === "swap" && slippageBps == null && pair && payValue > 0 && depth
    ? walkBook(depth, pair.side, payValue, price)
    : null;
  const slippageLabel = slippageBps == null
    ? "Off"
    : (SLIPPAGE.find((choice) => choice.bps === slippageBps)?.label ?? `${slippageBps / 100}%`);
  const worstPrice = pair && price > 0 && slippageBps != null
    ? safeSlippagePrice(price, pair.side, slippageBps, pair.market.pricePlaces)
    : null;

  const problem = (): string => {
    if (!rows) return "Check balances first.";
    const value = Number(amount);
    if (!pay || !(value > 0)) return "Enter an amount.";
    if (trading) {
      if (!pair) return "SafeTrade has no direct market for that pair.";
      if (panel === "limit") {
        if (!(Number(limitPrice) > 0)) return "Enter a limit price.";
        const px = Number(limitPrice);
        const baseSize = pair.side === "sell" ? value : value / px;
        if (!(baseSize > 0) || baseSize < pair.market.minBase) {
          return `Minimum ${pair.side === "buy" ? "buy" : "sell"} is ${pair.market.minBase} ${pair.market.base.toUpperCase()}.`;
        }
      } else {
        if (slippageBps != null && price > 0 && safeSlippagePrice(price, pair.side, slippageBps, pair.market.pricePlaces) == null) {
          return "That slippage does not leave a usable price on this market.";
        }
        if (slippageBps == null && depthError && !depth) return depthError;
        if (slippageBps == null && depth && !bookFill) {
          const baseName = pair.market.base.toUpperCase();
          return pair.side === "buy"
            ? `Nobody is selling ${baseName} on this book.`
            : `Nobody is buying ${baseName} on this book.`;
        }
        const base = pair.market.base.toUpperCase();
        if (pair.side === "sell" && value < pair.market.minBase) {
          return `Minimum ${base} sell is ${pair.market.minBase}.`;
        }
        const buySize = pair.side === "buy"
          ? (bookFill ? bookFill.base : (price > 0 ? value / price : null))
          : null;
        if (buySize != null && buySize < pair.market.minBase) {
          return `Minimum buy is ${pair.market.minBase} ${base}.`;
        }
      }
      const spot = balanceOf(pay.symbol);
      const available = spot?.available ?? 0;
      if (value > available) return freeLockedMessage(pay.symbol, available, spot?.locked ?? 0);
      return "";
    }
    if (moveDir === "deposit") {
      if (!pay.canDeposit) return `${pay.symbol} cannot be deposited from this wallet.`;
      // A WART deposit goes on the Warthog mainnet. Without a mainnet node
      // there is nothing to deposit from.
      if (pay.chain === "wart" && !mainnetNode) {
        return mainnetAnyNode
          ? "No mainnet node selected. SafeTrade has no Warthog testnet."
          : "No mainnet node configured. SafeTrade has no Warthog testnet.";
      }
      if (!addressFor(pay) && pay.chain !== "wart") return "This wallet has no address on that network.";
      const held = walletHolds[pay.id];
      if (!held) return "Checking the wallet balance.";
      if (held.failed) return `${pay.network} ${pay.symbol} balance unavailable.`;
      if (held.text !== "—" && Number(amount) > Number(held.text) + 1e-9) {
        return `Only ${held.text} ${pay.symbol} is in this wallet.`;
      }
      return "";
    }
    if (!addressFor(pay)) return "This wallet has no address to withdraw to.";
    return "";
  };

  const submit = async () => {
    if (!creds || !pay) return;
    const value = Number(amount);
    flow.begin(panel === "limit"
      ? "Placing the limit order…"
      : panel === "swap"
        ? "Placing the SafeTrade order…"
        : moveDir === "deposit" ? "Sending the deposit…" : "Submitting the withdrawal…");
    let submitted = false;
    try {
      if (trading) {
        if (!pair) throw new Error("SafeTrade has no direct market for that pair.");
        const spot = balanceOf(pay.symbol);
        const available = spot?.available ?? 0;
        if (value > available) {
          flow.finish(false, "Insufficient free balance", freeLockedMessage(pay.symbol, available, spot?.locked ?? 0));
          return;
        }
        if (panel === "limit") {
          const price = Number(limitPrice);
          const base = pair.side === "sell" ? value : value / price;
          flow.setStep("Resting the order on SafeTrade…");
          const order = await safeLimitOrder(creds, { market: pair.market, side: pair.side, amount: base, price });
          const done = `Limit ${pair.side} resting at ${order.price || price} ${pair.market.quote.toUpperCase()}.`;
          setNotice(done);
          submitted = true;
          try { setRows(await safeBalances(creds)); } catch { /* order already resting */ }
          flow.finish(true, "Limit placed", done);
          return;
        }
        flow.setStep("Waiting for SafeTrade to fill the order…");
        const order = await safeSwap(creds, { ...pair, amount: value, slippageBps });
        const finished = order.id ? await safeWaitOrder(creds, order.id) : order;
        const done = finished.filled > 0
          ? `Filled ${finished.filled} ${pair.market.base.toUpperCase()}.`
          : "The order is placed. It may still be filling.";
        setNotice(done);
        submitted = true;
        try { setRows(await safeBalances(creds)); } catch { /* order already placed */ }
        flow.finish(true, finished.filled > 0 ? "Swapped" : "Order placed", done);
        return;
      }
      if (moveDir === "deposit") {
        const limits = await safePublicNetwork(pay.currency, pay.blockchainKey);
        if (limits && !limits.depositEnabled) throw new Error("SafeTrade has deposits turned off for this coin.");
        const dest = await safeDepositAddress(creds, pay.currency, pay.blockchainKey);
        if (pay.chain === "wart") {
          await sendWart(dest, amount.trim());
        } else if (pay.chain === "bitcoin") {
          await sendBtc(dest, amount.trim());
        } else if (pay.chain === "solana") {
          if (pay.currency === "sol") {
            await sendSol(dest, amount.trim());
          } else if (pay.currency === "usdc" || pay.currency === "usdt") {
            await sendSpl({
              mint: pay.currency === "usdc" ? USDC_MINT : USDT_MINT,
              decimals: pay.decimals,
              toOwner: dest,
              amount: amount.trim(),
              symbol: pay.symbol,
            });
          } else {
            throw new Error(`This wallet cannot send ${pay.symbol} on Solana yet.`);
          }
        } else {
          await sendEthAsset(pay.currency === "eth" ? "ETH" : pay.currency === "usdc" ? "USDC" : "USDT", dest, amount.trim());
        }
        const sent = `${amount.trim()} ${pay.symbol} sent to SafeTrade.`;
        setNotice(sent);
        submitted = true;
        flow.finish(true, "Deposit sent", sent);
        return;
      }
      const result = await safeWithdrawCoin(creds, {
        currency: pay.currency,
        blockchainKey: pay.blockchainKey,
        min: pay.minWithdraw,
        fee: pay.fee,
        decimals: pay.decimals,
        bookLabel: pay.symbol,
      }, {
        amount: value,
        address: addressFor(pay),
        emailCode,
        otpCode,
      });
      if ("needCode" in result && result.needCode) {
        flow.finish(false, "Code needed", result.message);
        return;
      }
      if ("id" in result) {
        setEmailCode("");
        const sent = `Withdraw ${result.amount} ${pay.symbol} submitted.`;
        setNotice(sent);
        submitted = true;
        try { setRows(await safeBalances(creds)); } catch { /* withdraw already submitted */ }
        flow.finish(true, "Withdraw submitted", sent);
      }
    } catch (err) {
      if (!submitted) flow.finish(false, "Could not finish", explainExchangeFailure(err));
    }
  };

  async function sendWart(to: string, wartAmount: string) {
    if (wallet.ledgerAccount) throw new Error("Ledger WART deposits use Send on the Warthog home.");
    if (!wallet.signingUnlocked) throw new Error("Unlock the wallet before depositing WART.");
    const live =
      wallet.wallet && mainnetNode
        ? await fetchBalanceAndPin(mainnetNode, wallet.wallet)
        : null;
    if (live && amountExceedsAvailable(wartAmount, live.available)) {
      throw new Error(insufficientFreeBalanceMessage({
        available: live.available,
        locked: live.locked,
        unit: "WART",
      }));
    }
    const fee = RoundedFee.fromE8(BigInt(Math.round(parseFloat(DEFAULT_TX_FEE) * 1e8)), false);
    if (!fee) throw new Error("Invalid fee.");
    const context = await createTransactionContext(wallet.nodeList, mainnetIndex, fee, NonceId.random());
    const toAddr = Address.fromHex(to);
    const parsed = Wart.parse(wartAmount);
    if (!toAddr || !parsed) throw new Error("SafeTrade returned an address this wallet cannot pay.");
    const tx = await signPreparedWarthog(context, {
      op: "wartTransfer",
      toAddr: toAddr.hex,
      amountE8: parsed.E8.toString(),
    }, wallet.wallet || undefined);
    await submitTransaction(wallet.nodeList, mainnetIndex, tx as TransactionJson);
  }

  const safeReceiveText = (): string => {
    const value = Number(amount);
    if (!(value > 0)) return "0";
    if (trading) {
      if (!pair) return "0";
      if (panel === "swap") {
        if (bookFill) {
          return pair.side === "sell"
            ? floorText(bookFill.quote, pair.market.totalPlaces)
            : floorText(bookFill.base, pair.market.amountPlaces);
        }
        if (!(price > 0)) return "0";
        return pair.side === "sell"
          ? floorText(value * price, pair.market.totalPlaces)
          : floorText(value / price, pair.market.amountPlaces);
      }
      const px = Number(limitPrice);
      if (!(px > 0)) return "0";
      const out = pair.side === "sell" ? value * px : value / px;
      return trimAmount(out);
    }
    if (moveDir === "withdraw") return trimAmount(Math.max(0, value - (pay?.fee ?? 0)));
    return trimAmount(value);
  };

  const beginReview = async () => {
    const issue = problem();
    setError(issue);
    if (issue) return;
    if (panel !== "swap" || slippageBps != null || !pair) {
      setReviewFill(null);
      setOpen(true);
      return;
    }
    const id = pair.market.id;
    const value = Number(amount);
    setReviewing(true);
    try {
      const [next, tick] = await Promise.all([
        safeDepth(id),
        safeTicker(id).catch(() => null),
      ]);
      if (depthMarket.current === id) {
        depthRef.current = next;
        setDepth(next);
        setDepthError("");
      }
      if (tick) {
        const last = Number(tick.last) || 0;
        setPrice(last);
        setLastText(tick.last);
        setChange(tick.change);
      }
      const ref = tick ? Number(tick.last) : price;
      const fill = walkBook(next, pair.side, value, Number.isFinite(ref) ? ref : 0);
      if (!fill) {
        const baseName = pair.market.base.toUpperCase();
        setError(pair.side === "buy"
          ? `Nobody is selling ${baseName} on this book.`
          : `Nobody is buying ${baseName} on this book.`);
        return;
      }
      setReviewFill(fill);
      setOpen(true);
    } catch (err) {
      setError(explainExchangeFailure(err));
    } finally {
      setReviewing(false);
    }
  };

  const refreshBook = () => {
    if (!marketId || depthBusy) return;
    depthMarket.current = marketId;
    setDepthBusy(true);
    void safeDepth(marketId).then((next) => {
      if (depthMarket.current !== marketId) return;
      depthRef.current = next;
      setDepth(next);
      setDepthError("");
    }).catch((err: unknown) => {
      if (depthMarket.current !== marketId || depthRef.current) return;
      setDepthError(explainExchangeFailure(err));
    }).finally(() => {
      if (depthMarket.current === marketId) setDepthBusy(false);
    });
  };

  const held = pay ? walletHolds[pay.id] : undefined;
  const depositHint = !held
    ? "Available …"
    : held.failed
      ? "Balance unavailable"
      : `Available ${held.text} ${pay?.symbol ?? ""} in this wallet`;
  const walletRows = routesOn(network).flatMap((route) => {
    const row = walletHolds[route.id];
    if (!row || row.failed || !(Number(row.text) > 0)) return [];
    return [{ route, row }];
  });
  const reviewIssue = problem();
  const quoteUnit = pair?.market.quote.toUpperCase() ?? "";
  const baseUnit = pair?.market.base.toUpperCase() ?? "";
  const pricePlaces = pair?.market.pricePlaces ?? 0;
  const atLeast = payValue > 0 && worstPrice != null && pair
    ? floorText(
      pair.side === "sell" ? payValue * worstPrice : payValue / worstPrice,
      pair.side === "sell" ? pair.market.totalPlaces : pair.market.amountPlaces,
    )
    : "";
  const offReceive = reviewFill
    ? (pair?.side === "sell"
      ? floorText(reviewFill.quote, pair?.market.totalPlaces ?? 4)
      : floorText(reviewFill.base, pair?.market.amountPlaces ?? 4))
    : safeReceiveText();
  const shownIssue = reviewIssue && reviewIssue !== "Enter an amount." && reviewIssue !== "Check balances first."
    ? reviewIssue
    : "";

  return (
    <div className="container space-y-3 pb-8">
      <Header title="SafeTrade" />
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">SafeTrade</p>
        <NetworkBadge network="mainnet" />
      </div>
      <p className="text-xs leading-relaxed text-white/50">
        Checks the WART/USDT account on safe.trade. The key stays in this browser.
        SafeTrade accepts the call only from a trusted IPv4.
      </p>
      <ForwarderCard />
      {!mainnetNode ? (
        <div className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2">
          <NodeError
            message={mainnetReason}
            to="/mainnet-nodes"
            linkLabel="Add a mainnet node"
            className="text-xs text-red-200"
          />
        </div>
      ) : null}
      <p className="text-xs text-white/70">
        {creds ? `Key on this device ${keyHint(creds.apiKey)}` : "No SafeTrade key saved in this browser yet."}
      </p>
      <div className="space-y-2">
        <input
          className={field}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={creds ? "Paste a new key to replace" : "SafeTrade API key"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={checking}
        />
        <input
          className={field}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={creds ? "Paste the secret with the new key" : "HMAC secret"}
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={checking}
        />
        <button
          type="button"
          className="w-full rounded-lg bg-primary py-2 text-sm font-semibold text-black disabled:opacity-60"
          onClick={() => void checkBalances()}
          disabled={checking}
        >
          {checking ? "Checking…" : apiKey.trim() || secret.trim() ? "Save and check balances" : "Check balances"}
        </button>
        {creds ? (
          <button
            type="button"
            className="text-xs text-white/50"
            onClick={() => { void forgetKey(); }}
            disabled={checking}
          >
            Remove saved key
          </button>
        ) : null}
      </div>
      {rows ? (
        <div className="space-y-1 rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
          <p className="font-semibold text-white">SafeTrade accepted this address</p>
          <p className="pt-1 text-[10px] uppercase tracking-wide text-white/40">WART</p>
          <p className="text-white">{balanceLine(rows, "WART")}</p>
          <p className="pt-1 text-[10px] uppercase tracking-wide text-white/40">USDT</p>
          <p className="text-white">{balanceLine(rows, "USDT")}</p>
          {rows
            .filter((row) => row.asset !== "WART" && row.asset !== "USDT" && (row.available > 0 || row.locked > 0))
            .map((row) => (
              <p key={row.asset} className="text-xs text-white/60">
                {row.asset} {balanceLine([row], row.asset)}
              </p>
            ))}
        </div>
      ) : null}
      {checkError ? <p className="text-sm text-red-400">{checkError}</p> : null}
      <div className="rounded-lg border border-white/10 px-3 py-2">
        <p className="text-[10px] font-semibold tracking-[1.2px] text-zinc-500 uppercase">
          In this wallet · {network}
        </p>
        {walletRows.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">
            {Object.keys(walletHolds).length === 0 ? "Checking wallet balances…" : `No token balance on ${network} yet.`}
          </p>
        ) : walletRows.map(({ route, row }) => (
          <button
            key={route.id}
            type="button"
            className="mt-1 flex w-full items-center justify-between gap-3 text-left"
            onClick={() => setPayId(route.id)}
          >
            <span className="text-sm font-semibold text-white">{route.symbol}</span>
            <span className="font-mono text-sm text-zinc-200">{row.text}</span>
          </button>
        ))}
      </div>
      <SwapStyleCard
        title={panel === "limit" ? "Limit" : panel === "swap" ? "Swap" : moveDir === "deposit" ? "Deposit" : "Withdraw"}
        subtitle={trading
          ? (pair ? `${pair.market.base.toUpperCase()}/${pair.market.quote.toUpperCase()}` : "No direct market")
          : `${pay?.symbol ?? ""} · ${network}`}
        spotLabel="Price"
        spotValue={trading && (lastText || price > 0) ? (lastText || String(price)) : undefined}
        mark={<img src={safetradeMark} alt="SafeTrade" className="h-6 w-6" />}
        toolbar={(
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={panel === "swap" ? chipOn : chip} onClick={() => setPanel("swap")}>Swap</button>
            <button type="button" className={panel === "limit" ? chipOn : chip} onClick={() => setPanel("limit")}>Limit</button>
            <button
              type="button"
              className={panel === "move" && moveDir === "deposit" ? chipOn : chip}
              onClick={() => { setPanel("move"); setMoveDir("deposit"); }}
            >
              Deposit
            </button>
            <button
              type="button"
              className={panel === "move" && moveDir === "withdraw" ? chipOn : chip}
              onClick={() => { setPanel("move"); setMoveDir("withdraw"); }}
            >
              Withdraw
            </button>
            <TickerMenu
              className="ticker-menu--chip ticker-menu--end"
              ariaLabel="SafeTrade network"
              value={network}
              onChange={(id) => {
                const next = id as (typeof NETWORKS)[number];
                setNetwork(next);
                const first = routesOn(next)[0];
                if (first) setPayId(first.id);
              }}
              items={NETWORKS.map((name) => ({
                id: name,
                label: name,
                symbol: name === "Warthog" ? "WART" : name === "Ethereum" ? "ETH" : name === "Bitcoin" ? "BTC" : "SOL",
              }))}
            />
          </div>
        )}
        payHint={panel === "move" && moveDir === "deposit"
          ? depositHint
          : !rows
            ? "Check balances first."
            : pay
              ? balanceLine(rows, pay.symbol)
              : "Check balances first."}
        onMax={panel === "move" && moveDir === "deposit"
          ? (pay && walletHolds[pay.id]?.max
            ? () => setAmount(walletHolds[pay.id].max)
            : undefined)
          : !pay || !rows
            ? undefined
            : (balanceOf(pay.symbol)?.available ?? 0) > 0
              ? () => setAmount(formatBalance(balanceOf(pay.symbol)?.available ?? 0))
              : undefined}
        amount={amount}
        onAmount={setAmount}
        paySymbol={pay?.symbol ?? "—"}
        payChoices={routesOn(network).map((route) => ({ id: route.id, symbol: route.symbol, mark: route.symbol }))}
        payValue={pay?.id ?? ""}
        onPay={(id) => {
          const next = SAFE_ROUTES.find((route) => route.id === id);
          setPayId(id);
          if (next && trading) setNetwork(next.network as (typeof NETWORKS)[number]);
        }}
        receiveHint={trading
          ? (panel === "swap" && slippageBps == null
            ? "Estimate · from the order book, before the fee"
            : panel === "limit"
              ? "If the limit fills, before the fee"
              : "Estimate · at the last price, before the fee")
          : moveDir === "deposit" ? "On SafeTrade" : "In this wallet · after the fee"}
        receiveAmount={safeReceiveText()}
        receiveSymbol={trading ? (receive?.symbol ?? "—") : (pay?.symbol ?? "—")}
        receiveChoices={trading
          ? receiveChoices.map((route) => ({
            id: route.id,
            symbol: route.symbol,
            mark: route.symbol,
          }))
          : undefined}
        receiveValue={receive?.id ?? ""}
        onReceive={trading ? setReceiveId : undefined}
        onFlip={trading && pay && receive ? () => {
          setPayId(receive.id);
          setReceiveId(pay.id);
          setNetwork(receive.network as (typeof NETWORKS)[number]);
        } : panel === "move" ? () => setMoveDir((dir) => (dir === "deposit" ? "withdraw" : "deposit")) : undefined}
        extra={panel === "limit" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                className={field}
                value={limitPrice}
                onChange={(event) => setLimitPrice(event.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="Limit price"
                inputMode="decimal"
              />
              <button
                type="button"
                className={chip}
                onClick={() => {
                  if (!(price > 0) || !pair) return;
                  setLimitPrice(price.toFixed(pair.market.pricePlaces));
                }}
              >
                Last
              </button>
            </div>
            {orders.length > 0 ? (
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">Open on this market</p>
                {orders.map((order) => (
                  <div key={order.id} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                    <span>{order.side} {order.origin} @ {order.price}</span>
                    <button type="button" className="text-primary" onClick={() => {
                      if (!creds || !pair) return;
                      void safeCancelOrder(creds, order.id)
                        .then(() => setNotice("Order canceled."))
                        .catch((err: unknown) => setError(explainExchangeFailure(err)));
                    }}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : panel === "move" && moveDir === "withdraw" ? (
          <div className="grid grid-cols-2 gap-2">
            <input className={field} value={emailCode} onChange={(event) => setEmailCode(event.target.value)} placeholder="Email code" />
            <input className={field} value={otpCode} onChange={(event) => setOtpCode(event.target.value)} placeholder="2FA code" inputMode="numeric" />
          </div>
        ) : null}
        summary={trading ? (
          <div className="space-y-2">
            {pay && receive && !pair ? (
              <p>SafeTrade has no {pay.symbol}/{receive.symbol} market.</p>
            ) : null}
            {panel === "swap" ? (
              <>
                <p>Slippage limit</p>
                <div className="flex flex-wrap gap-2">
                  {SLIPPAGE.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      className={slippageBps === choice.bps ? chipOn : chip}
                      aria-pressed={slippageBps === choice.bps}
                      onClick={() => setSlippageBps(choice.bps)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
                <p>
                  {slippageBps == null
                    ? "No price cap. Review shows the average price and the slippage amount from the book before the order is sent."
                    : "SafeTrade stops the order at the worst price. It stays on SafeTrade until you withdraw."}
                </p>
                {slippageBps == null && pair ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <span>Average price</span>
                      <span className="text-right text-zinc-200">
                        {bookFill ? `${bookFill.averagePrice.toFixed(pricePlaces)} ${quoteUnit}` : (depth ? "…" : "Reading the book…")}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <span>Slippage amount</span>
                      <span className="text-right text-zinc-200">
                        {bookFill ? slippageAmountText(bookFill, quoteUnit, pair.market.totalPlaces) : "…"}
                      </span>
                    </div>
                  </>
                ) : null}
                {slippageBps != null && worstPrice != null ? (
                  <div className="flex items-start justify-between gap-3">
                    <span>Worst price</span>
                    <span className="text-right text-zinc-200">{worstPrice.toFixed(pricePlaces)} {quoteUnit}</span>
                  </div>
                ) : null}
                {bookFill && !bookFill.complete && pair ? (
                  <p className="text-amber-200/90">
                    {coverageText(bookFill, baseUnit, quoteUnit, pair.market.amountPlaces, pair.market.totalPlaces)}
                  </p>
                ) : null}
              </>
            ) : null}
            {pair ? (
              <OrderBook
                market={pair.market}
                depth={depth}
                error={depthError}
                busy={depthBusy && !depth}
                last={lastText}
                change={change}
                touched={panel === "swap" ? bookFill?.touched ?? 0 : 0}
                touchSide={pair.side}
                onPickPrice={panel === "limit" ? (px) => {
                  setLimitPrice(px);
                  setError("");
                } : undefined}
                onRefresh={refreshBook}
              />
            ) : null}
          </div>
        ) : undefined}
        error={error || shownIssue}
        hint={notice || (panel === "limit"
          ? "A limit rests at the price you type until it fills or you cancel it."
          : panel === "swap"
            ? (slippageBps == null
              ? "No price cap. Review shows the average price and the slippage amount before the order is sent."
              : "The swap stays on SafeTrade until you withdraw.")
            : "Deposit sends from this wallet. Withdraw pays back to this wallet.")}
        cta={reviewing
          ? "Reading the book…"
          : panel === "limit" ? "Review limit" : panel === "swap" ? "Review swap" : moveDir === "deposit" ? "Review deposit" : "Review withdraw"}
        ctaDisabled={!rows || flow.busy || reviewing || Boolean(reviewIssue)}
        onCta={() => { void beginReview(); }}
      />
      <SpendConfirm
        open={open}
        title={panel === "limit" ? "Confirm limit" : panel === "swap" ? "Confirm swap" : moveDir === "deposit" ? "Confirm deposit" : "Confirm withdraw"}
        rows={panel === "swap" && slippageBps == null ? [
          { label: "You pay", value: `${amount.trim() || "—"} ${pay?.symbol ?? ""}` },
          { label: "You receive about", value: `${offReceive} ${receive?.symbol ?? ""}` },
          { label: "Average price", value: reviewFill ? `${reviewFill.averagePrice.toFixed(pricePlaces)} ${quoteUnit}` : "…" },
          { label: "Slippage", value: reviewFill ? slippagePercent(reviewFill) : "…" },
          { label: "Slippage amount", value: reviewFill ? slippageAmountText(reviewFill, quoteUnit, pair?.market.totalPlaces ?? 4) : "…" },
          { label: "Book", value: reviewFill && pair ? coverageText(reviewFill, baseUnit, quoteUnit, pair.market.amountPlaces, pair.market.totalPlaces) : "…" },
          { label: "Slippage limit", value: "Off" },
          { label: "Market", value: pair ? `${pair.market.base}/${pair.market.quote}` : "No direct market" },
        ] : panel === "swap" ? [
          { label: "You pay", value: `${amount.trim() || "—"} ${pay?.symbol ?? ""}` },
          { label: "You receive about", value: `${safeReceiveText()} ${receive?.symbol ?? ""}` },
          { label: "At the worst price", value: atLeast ? `${atLeast} ${pair?.side === "sell" ? quoteUnit : receive?.symbol ?? ""}` : "…" },
          { label: "Slippage", value: slippageLabel },
          { label: "Worst price", value: worstPrice != null ? `${worstPrice.toFixed(pricePlaces)} ${quoteUnit}` : "…" },
          { label: "Network", value: network },
          { label: "Market", value: pair ? `${pair.market.base}/${pair.market.quote}` : "No direct market" },
        ] : trading ? [
          { label: "You pay", value: `${amount.trim() || "—"} ${pay?.symbol ?? ""}` },
          { label: "You receive", value: `${safeReceiveText()} ${receive?.symbol ?? ""}` },
          { label: "Market", value: pair ? `${pair.market.base}/${pair.market.quote}` : "No direct market" },
          { label: "Limit price", value: limitPrice || "—" },
          { label: "Network", value: network },
        ] : [
          { label: moveDir === "deposit" ? "Deposit" : "Withdraw", value: `${amount.trim() || "—"} ${pay?.symbol ?? ""}` },
          { label: "Network", value: network },
          { label: moveDir === "deposit" ? "From this wallet" : "To", value: pay ? addressFor(pay) || "—" : "—" },
        ]}
        confirmLabel={panel === "limit" ? "Place limit" : panel === "swap" ? "Confirm and swap" : moveDir === "deposit" ? "Confirm deposit" : "Confirm withdraw"}
        busy={flow.busy}
        step={flow.step}
        outcome={flow.outcome}
        onCancel={() => {
          flow.close(() => setAmount(""));
          setReviewFill(null);
          setOpen(false);
        }}
        onConfirm={() => { void submit(); }}
      />
    </div>
  );
}

function OrderBook({
  market,
  depth,
  error,
  busy,
  last,
  change,
  touched,
  touchSide,
  onPickPrice,
  onRefresh,
}: {
  market: SafeMarket;
  depth: SafeDepth | null;
  error: string;
  busy: boolean;
  last: string;
  change: string;
  touched: number;
  touchSide: "buy" | "sell";
  onPickPrice?: (price: string) => void;
  onRefresh: () => void;
}) {
  const quote = market.quote.toUpperCase();
  const base = market.base.toUpperCase();
  const asks = (depth?.asks ?? []).slice(0, BOOK_ROWS).reverse();
  const bids = (depth?.bids ?? []).slice(0, BOOK_ROWS);
  const maxAmount = Math.max(1e-12, ...asks.map((row) => row.amount), ...bids.map((row) => row.amount));
  const changeText = formatChange(change);
  const changeDown = changeText.startsWith("-");
  const changeUp = changeText.startsWith("+");
  const levelRow = (level: { price: number; amount: number }, side: "buy" | "sell", hot: boolean) => {
    const width = Math.min(100, (level.amount / maxAmount) * 100);
    const priceText = level.price.toFixed(market.pricePlaces);
    const body = (
      <div className="relative flex min-h-[22px] items-center">
        <div
          className="absolute inset-y-px right-0 rounded-sm"
          style={{
            width: `${width}%`,
            background: side === "sell" ? "var(--defi-sell-muted)" : "var(--defi-buy-muted)",
            opacity: hot ? 1 : 0.7,
          }}
        />
        <span className="relative z-[1] flex-1 text-[11px] font-semibold tabular-nums" style={{ color: side === "sell" ? "var(--defi-sell)" : "var(--defi-buy)" }}>
          {priceText}
        </span>
        <span className="num-color relative z-[1] flex-1 text-right text-[11px] tabular-nums">
          {formatBook(level.amount, market.amountPlaces)}
        </span>
        <span className="num-color relative z-[1] flex-1 text-right text-[11px] tabular-nums">
          {formatBook(level.price * level.amount, market.totalPlaces)}
        </span>
      </div>
    );
    if (!onPickPrice) return body;
    return (
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => onPickPrice(priceText)}
        aria-label={`Use ${priceText} ${quote} as the limit price`}
      >
        {body}
      </button>
    );
  };
  return (
    <div className="rounded-[10px] border border-zinc-800 bg-zinc-950/40 p-2.5 text-zinc-400">
      <div className="mb-1 flex items-center justify-between">
        <span>{base}/{quote} order book</span>
        <button type="button" className="text-primary" onClick={onRefresh} disabled={busy} aria-label="Refresh order book">
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>
      <div className="mb-0.5 flex text-[10px] text-zinc-500">
        <span className="flex-1">Price ({quote})</span>
        <span className="flex-1 text-right">Amount ({base})</span>
        <span className="flex-1 text-right">Sum ({quote})</span>
      </div>
      {busy && !depth ? <p>Reading the book…</p> : null}
      {error && !depth ? <p className="text-amber-200/90">{error}</p> : null}
      {asks.map((level, index) => (
        <div key={`ask-${level.price}-${index}`}>
          {levelRow(level, "sell", touchSide === "buy" && asks.length - 1 - index < touched)}
        </div>
      ))}
      <div className="my-0.5 flex items-center justify-between border-y border-zinc-700/70 py-1.5">
        <span className="text-[15px] font-bold text-zinc-50">
          {last || "…"}
          <span className="ml-1 text-[11px] font-medium text-zinc-500">{quote}</span>
        </span>
        {changeText ? (
          <span style={{ color: changeDown ? "var(--defi-sell)" : changeUp ? "var(--defi-buy)" : undefined }} className={changeDown || changeUp ? undefined : "text-zinc-500"}>{changeText}</span>
        ) : null}
      </div>
      {bids.map((level, index) => (
        <div key={`bid-${level.price}-${index}`}>
          {levelRow(level, "buy", touchSide === "sell" && index < touched)}
        </div>
      ))}
      {depth && asks.length === 0 && bids.length === 0 ? <p>No orders on this market.</p> : null}
      {touched > BOOK_ROWS ? <p>The average also includes prices past these rows.</p> : null}
      {onPickPrice ? <p>Tap a price to use it as the limit.</p> : null}
    </div>
  );
}
