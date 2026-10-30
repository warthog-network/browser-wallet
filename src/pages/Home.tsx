import React, { useState, useEffect, useRef, useCallback } from "react";
import { searchAssetsDetailed, type AssetInfo } from "../utils/defiClient";
import { fetchWartUsdPrice } from "../utils/wartPrice";
import { shouldStartUpdate } from "../utils/updatePending";
import { fetchBalanceAndPin, nodeRead } from "../utils/warthogNode";
import { Tab } from "../components/TabNavigation";
import TransactionHistoryPanel, {
  type HistoryActivity,
} from "../components/TransactionHistoryPanel";
import PendingTxRow from "../components/PendingTxRow";
import CancelConfirmModal from "../components/CancelConfirmModal";
import { useNavigate } from "react-router-dom";
import useWallet from "../hooks/useWallet";
import { IoSend, IoTrendingUp, IoDownloadOutline, IoCloseCircleOutline, IoWater, IoDiamond } from "react-icons/io5";
import { useChainAccounts } from "../chains/useChainAccounts";
import ChainHoldings from "../components/chains/ChainHoldings";
import NetworkBadge from "../components/chains/NetworkBadge";
import ChainActivity from "../components/chains/ChainActivity";
import OpenOrders from "../components/OpenOrders";
import WatchedAssets from "../components/WatchedAssets";
import NodeError from "../components/NodeError";
import TokenMark from "../components/chains/TokenMark";
import AssetMark, { AssetTitle } from "../components/AssetMark";
import { TickerFace, type TickerMenuItem } from "../components/TickerMenu";
import { hasPositiveLocked } from "../utils/balanceBreakdown";
import { formatDisplayNumber, loadNumberDisplayPrefs } from "../utils/numberDisplay";
import { FaSync } from "react-icons/fa";
import SenderSummary from "../components/SenderSummary";
import { getPendingApproval, approveRequest, rejectRequest, PendingApproval } from "../utils/extensionApi";
import { createTransactionContext, formatAddress, submitTransaction } from "../utils";
import { Address, NonceId, RoundedFee, Wart } from "warthog-ts";
import { ledgerWartSubmitJson, signWartTransferOnLedger } from "../ledger/warthogApp";
import { readLedgerWindowMode, storeLedgerSignJob, takeLedgerLastTx, type LedgerWindowMode } from "../ledger/session";
import { isToolbarActionPopup, openLedgerHost, openLedgerInSidePanel } from "../ledger/shell";
import { reloadDocumentOnce } from "../utils/extensionNav";
import { DEFAULT_TX_FEE } from "../config/network";
import { isPlainHttpNode } from "../utils/nodes";
import { signPreparedWarthog } from "../utils/signingBridge";
import {
  type NodeMempoolEntry,
  type NodeTx,
} from "../types/nodeTx";

interface Token {
  spec: string;
  name: string;
  hash: string | null;
}

/** Map a node asset-search match onto the shape the balance UI selects with. */
const toToken = (match: AssetInfo): Token => ({
  spec: "asset",
  name: match.name || match.hash || "?",
  hash: match.hash ?? null,
});

const RECENT_TOKENS_KEY = 'recent_tokens';
const MAX_RECENT = 5;

function TokenSelector({ selectedToken, onSelect, nodeUrl, defi }: { selectedToken: Token; onSelect: (token: Token) => void; nodeUrl: string; defi: boolean }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Token[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [recentTokens, setRecentTokens] = useState<Token[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(RECENT_TOKENS_KEY);
    if (stored) {
      setRecentTokens(JSON.parse(stored) as Token[]);
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      return;
    }
    // Only a DeFi node has assets. Searching a mainnet node would fail on
    // an endpoint it does not serve, and the user would see no results for
    // no reason.
    if (!defi) {
      setSearchResults([]);
      return;
    }

    const search = async () => {
      setSearchLoading(true);
      try {
        const [byName, byHash] = await Promise.all([
          searchAssetsDetailed(nodeUrl, searchQuery),
          searchAssetsDetailed(nodeUrl, "", searchQuery),
        ]);
        const merged: Token[] = [
          ...byName.matches.map(toToken),
          ...byHash.matches.map(toToken),
        ];
        const unique = merged.filter((t, i, a) => a.findIndex(x => x.hash === t.hash) === i);
        setSearchResults(unique.slice(0, 20));
      } catch (err) {
        console.error('Search failed:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    };

    search();
  }, [searchQuery, nodeUrl, defi]);

  const handleSelect = (token: Token) => {
    onSelect(token);
    setShowDropdown(false);
    setSearchQuery('');
    setSearchResults([]);

    const stored = localStorage.getItem(RECENT_TOKENS_KEY);
    let recent: Token[] = stored ? JSON.parse(stored) : [];
    recent = recent.filter((t: Token) => t.hash !== token.hash);
    recent.unshift(token);
    recent = recent.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_TOKENS_KEY, JSON.stringify(recent));
    setRecentTokens(recent);
  };

  const tokenItem = (token: Token): TickerMenuItem => token.hash
    ? {
        id: token.hash,
        label: token.name,
        hash: token.hash,
        name: token.name,
        hint: formatAddress(token.hash, 6),
      }
    : { id: "wart", label: "WART", symbol: "WART", hint: "Native currency" };

  return (
    <div className={`ticker-menu ticker-menu--field${showDropdown ? " ticker-menu--open" : ""}`} ref={dropdownRef}>
      <button
        type="button"
        className="ticker-menu-btn"
        aria-haspopup="listbox"
        aria-expanded={showDropdown}
        onClick={() => setShowDropdown(!showDropdown)}
      >
        <TickerFace item={tokenItem(selectedToken)} size={18} compact />
        <span className="ticker-menu-chevron" aria-hidden="true">{showDropdown ? "▴" : "▾"}</span>
      </button>

      {showDropdown && (
        <div className="ticker-menu-panel">
          {defi ? (
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tokens"
              className="ticker-menu-search"
              aria-label="Search tokens"
              autoFocus
            />
          ) : (
            <p className="ticker-menu-note">
              Assets are on the DeFi testnet. Switch the network to pick one.
            </p>
          )}

          <div className="ticker-menu-list" role="listbox" aria-label="Assets">
            {!searchQuery && recentTokens.length > 0 && (
              <div>
                <div className="ticker-menu-label">Recent</div>
                {/* A testnet asset does not belong in a mainnet list. */}
                {recentTokens
                  .filter((token) => defi || !token.hash)
                  .map((token) => (
                  <button
                    key={token.hash || "wart"}
                    type="button"
                    role="option"
                    onClick={() => handleSelect(token)}
                    className="ticker-menu-option"
                  >
                    <TickerFace item={tokenItem(token)} />
                  </button>
                ))}
              </div>
            )}

            {searchQuery && (
            <div>
              <div className="ticker-menu-label">Search results</div>
              {searchLoading && (
                <p className="ticker-menu-note">Searching...</p>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <p className="ticker-menu-note">No tokens found</p>
              )}
              {!searchLoading && searchResults.map((token) => (
                <button
                  key={token.hash}
                  type="button"
                  role="option"
                  onClick={() => handleSelect({ spec: "asset", name: token.name, hash: token.hash })}
                  className="ticker-menu-option"
                >
                  <TickerFace item={tokenItem(token)} />
                </button>
              ))}
            </div>
            )}

            {!searchQuery && (
              <button
                type="button"
                role="option"
                onClick={() => handleSelect({ spec: "WART", name: "WART", hash: null })}
                className="ticker-menu-option"
              >
                <TickerFace item={{ id: "wart", label: "WART", symbol: "WART", hint: "Native currency" }} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const Home: React.FC<{ view?: "wallet" | "activity" }> = ({ view = "wallet" }) => {
  const {
    wallet,
    selectedNodeIndex,
    nodeList,
    ledgerAccount,
    activeNetwork,
    nodeError,
    selectedNode,
  } = useWallet();
  const { accounts, chains, chain, phrasePending, addressError, network, setNetwork, address } = useChainAccounts();
  const navigate = useNavigate();
  const [balance, setBalance] = useState(0);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceUSD, setBalanceUSD] = useState(0);
  const [wartSpend, setWartSpend] = useState({
    available: "0",
    locked: "0",
    total: "0",
    hasLocked: false,
  });
  // The node that has an update running. The node URL carries the network
  // with it, because a node belongs to one family. An update is assigned
  // to the node it was started for, so a second request for the same node
  // is not started while the first is still running.
  const [pendingNodeUrl, setPendingNodeUrl] = useState<string | null>(null);
  // The same thing as a ref, so the read can read it without the effect
  // that starts the read having to depend on it.
  const pendingNodeRef = useRef<string | null>(null);
  // The node the wallet is on. A read that finishes after the wallet moved
  // to another node must not overwrite what that node says.
  //
  // It is set while rendering, not in an effect, so it is right on the
  // first render too and never lags a commit behind the state.
  const currentNodeRef = useRef<string | null>(selectedNode?.url ?? null);
  currentNodeRef.current = selectedNode?.url ?? null;
  const [holdingsTick, setHoldingsTick] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [showApprovalBanner, setShowApprovalBanner] = useState(false);
  const [selectedToken, setSelectedToken] = useState<Token>({ spec: 'WART', name: 'WART', hash: null });
  // WART is the native currency. Any other selection is a DeFi testnet
  // asset, which only the testnet node knows about.
  // The card is pending while the update of the node the wallet is on is
  // running. An update of another node does not make this one wait.
  const refreshing = Boolean(
    chain === "wart" && pendingNodeUrl && pendingNodeUrl === currentNodeRef.current,
  );

  const [activeTab, setActiveTab] = useState<Tab>(view === "activity" ? Tab.History : Tab.Actions);
  const [showOrders, setShowOrders] = useState(false);
  const [ledgerNote, setLedgerNote] = useState<string | null>(null);
  const windowModeRef = useRef<LedgerWindowMode>("dropdown");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [pendingTxs, setPendingTxs] = useState<NodeMempoolEntry[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelTx, setCancelTx] = useState<NodeTx | null>(null);
  const [cancelType, setCancelType] = useState<string>("");
  const openActivity = (item: HistoryActivity) => {
    navigate("/activity-details", { state: item });
  };

  /** Asset selection never changes the active network. */
  const selectToken = useCallback(
    (token: Token) => {
      setSelectedToken(token);
    },
    [],
  );

  useEffect(() => {
    void readLedgerWindowMode().then((mode) => {
      windowModeRef.current = mode;
    });
    void takeLedgerLastTx().then((hash) => {
      if (hash) setLedgerNote(`Broadcast ${hash}`);
    });
  }, []);

  const loadPending = useCallback(async () => {
    if (!wallet || !nodeList[selectedNodeIndex]) return;

    const nodeUrl = nodeList[selectedNodeIndex].url;
    setPendingLoading(true);
    try {
      const entries = await nodeRead<NodeMempoolEntry[]>(
        nodeUrl,
        `account/${wallet}/mempool`,
      );
      setPendingTxs(Array.isArray(entries) ? entries : []);
    } catch (err) {
      console.error("Error fetching pending:", err);
      setPendingTxs([]);
    } finally {
      setPendingLoading(false);
    }
  }, [wallet, nodeList, selectedNodeIndex]);

  useEffect(() => {
    if (activeTab === Tab.Pending) {
      loadPending();
      const interval = setInterval(loadPending, 15000);
      return () => clearInterval(interval);
    }
  }, [activeTab, loadPending]);

  const handleCancel = (tx: NodeTx, type: string) => {
    setCancelTx(tx);
    setCancelType(type);
    setShowCancelModal(true);
  };

  const handleApprove = async () => {
    if (chain !== "wart") {
      setLedgerNote("Select the Warthog network requested by this site before approving.");
      return;
    }
    if (pendingApproval?.from && pendingApproval.from.toLowerCase() !== wallet?.toLowerCase()) {
      setLedgerNote("This request is for another account. Select that account in the header before approving.");
      return;
    }
    if (pendingApproval?.action === 'requestAccounts') {
      if (!wallet) return;
      await approveRequest([wallet]);
      setShowApprovalBanner(false);
      setPendingApproval(null);
      return;
    }
    if (pendingApproval?.action === 'openSendPage') {
      await approveRequest();
      setShowApprovalBanner(false);
      setPendingApproval(null);
      navigate(`/send?address=${pendingApproval.to}`);
      return;
    }
    if (
      ledgerAccount &&
      (pendingApproval?.action === 'sendTransaction' || pendingApproval?.action === 'transferWart')
    ) {
      setApprovalBusy(true);
      setLedgerNote(null);
      try {
        const toAddr = Address.fromHex(pendingApproval.to || "");
        if (!toAddr) throw new Error("Invalid recipient address");
        const wartParsed = Wart.parse(pendingApproval.amount || "0");
        if (!wartParsed) throw new Error("Invalid WART amount");
        const fee = RoundedFee.fromE8(
          BigInt(Math.round(parseFloat(DEFAULT_TX_FEE) * 1e8)),
          false,
        );
        if (!fee) throw new Error("Invalid fee");
        const nonceId = NonceId.random();
        const handOff = isToolbarActionPopup();
        const opened = handOff && windowModeRef.current === "sidepanel"
          ? await openLedgerInSidePanel("/ledger-host?op=sign")
          : false;
        const context = await createTransactionContext(nodeList, selectedNodeIndex, fee, nonceId);
        if (handOff) {
          await storeLedgerSignJob({
            pinHash: context.chainPin.pinHash,
            pinHeight: context.chainPin.pinHeight,
            nonceId: nonceId.value,
            feeE8: fee.E8.toString(),
            toAddress: toAddr.hex,
            amountE8: wartParsed.E8.toString(),
            nodeIndex: selectedNodeIndex,
            approveDapp: true,
          });
          if (!opened) await openLedgerHost("op=sign");
          window.close();
          return;
        }
        const tx = await signWartTransferOnLedger(ledgerAccount, {
          pinHash: context.chainPin.pinHash,
          pinHeight: context.chainPin.pinHeight,
          nonceId: nonceId.value,
          feeE8: fee.E8,
          toAddress: toAddr.hex,
          amountE8: wartParsed.E8,
        });
        const txHash = await submitTransaction(
          nodeList,
          selectedNodeIndex,
          ledgerWartSubmitJson(tx, nodeList[selectedNodeIndex]),
        );
        await approveRequest(undefined, txHash);
        setShowApprovalBanner(false);
        setPendingApproval(null);
        setLedgerNote(`Broadcast ${txHash}`);
      } catch (error) {
        setLedgerNote(error instanceof Error ? error.message : "Ledger sign failed");
      } finally {
        setApprovalBusy(false);
      }
      return;
    }
    if (pendingApproval?.action === "sendTransaction" || pendingApproval?.action === "transferWart") {
      setApprovalBusy(true);
      setLedgerNote(null);
      try {
        if (!wallet) throw new Error("No account selected");
        const recipient = Address.fromHex(pendingApproval.to || "");
        const amount = Wart.parse(pendingApproval.amount || "0");
        const fee = RoundedFee.fromE8(BigInt(Math.round(Number(DEFAULT_TX_FEE) * 1e8)), false);
        if (!recipient || !amount || !fee) throw new Error("Invalid transaction request");
        const context = await createTransactionContext(nodeList, selectedNodeIndex, fee, NonceId.random());
        const transaction = await signPreparedWarthog(context, {
          op: "wartTransfer",
          toAddr: recipient.hex,
          amountE8: amount.E8.toString(),
        }, wallet);
        const hash = await submitTransaction(nodeList, selectedNodeIndex, transaction);
        await approveRequest(undefined, hash);
        setShowApprovalBanner(false);
        setPendingApproval(null);
      } catch (error) {
        setLedgerNote(error instanceof Error ? error.message : "Signing failed");
      } finally { setApprovalBusy(false); }
    }
  };

  const handleReject = async () => {
    await rejectRequest();
    setShowApprovalBanner(false);
    setPendingApproval(null);
  };

  /**
   * Read the balance from the node the wallet is on.
   *
   * The read is awaited so the pending state can follow it, and it is
   * assigned to the node it was started for. A result that arrives after
   * the wallet moved to another node is dropped: it says what the old
   * node thought, and the card now shows the new one.
   */
  const updateBalance = useCallback(
    async (ownsPending: boolean): Promise<void> => {
      const node = nodeList[selectedNodeIndex];
      if (!wallet || !node) return;
      const nodeUrl = node.url;
      const isCurrentNode = () => currentNodeRef.current === nodeUrl;

      try {
        if (selectedToken.hash) {
          const tokenSpec = `asset:${selectedToken.hash}`;
          const data = await nodeRead<{
            balance?: { total?: { u64?: number; decimals?: number } };
          }>(nodeUrl, `account/${wallet}/balance/${tokenSpec}`);
          if (!isCurrentNode()) return;
          if (data?.balance?.total?.u64 !== undefined) {
            const decimals = data.balance.total.decimals || 8;
            const amount = data.balance.total.u64 / Math.pow(10, decimals);
            setBalance(amount);
            setWartSpend({
              available: String(amount),
              locked: "0",
              total: String(amount),
              hasLocked: false,
            });
            setBalanceError(null);
          }
        } else {
          const result = await fetchBalanceAndPin(node, wallet);
          if (!isCurrentNode()) return;
          setBalance(parseFloat(result.balance) || 0);
          setWartSpend({
            available: result.available,
            locked: result.locked,
            total: result.balance,
            hasLocked: result.hasLocked,
          });
          setBalanceError(null);
        }
      } catch (error) {
        console.error("Error fetching balance:", error);
        const message =
          error instanceof Error ? error.message : "Could not load the balance";
        if (/failed to fetch/i.test(message) && reloadDocumentOnce()) return;
        if (!isCurrentNode()) return;
        setBalance(0);
        setBalanceError(message);
      } finally {
        // The update is over, whether it read the balance or failed. The
        // pending state ends here, so the card does not wait for a node
        // that never answers.
        //
        // Only the read that owns the pending state ends it. A background
        // poll reads the same node and must not cut the user's update short.
        if (ownsPending && pendingNodeRef.current === nodeUrl) {
          pendingNodeRef.current = null;
          setPendingNodeUrl(null);
        }
      }
    },
    [wallet, nodeList, selectedNodeIndex, selectedToken],
  );

  const updateBalanceUSD = useCallback(() => {
    // wartPrice tries CoinGecko, falls back to CoinPaprika, and caches. Home
    // previously polled CoinGecko alone every 1.5s with no fallback.
    fetchWartUsdPrice()
      .then((price) => {
        setBalanceUSD(price ?? 0);
      })
      .catch((error) => {
        console.error("Error fetching balance:", error);
      });
  }, []);

  useEffect(() => {
    const checkPendingApproval = async () => {
      const pending = await getPendingApproval();
      if (pending && pending.action) {
        setPendingApproval(pending);
        setShowApprovalBanner(true);
      }
    };
    checkPendingApproval();
  }, []);

  /**
   * Start an update for the node the wallet is on, if it is not already
   * running for it.
   *
   * The update is assigned to the node. An update that is already running
   * for that node is not started again, so toggling back to a node that is
   * still being read does not queue a second read of it.
   */
  const startUpdate = useCallback((nodeUrl: string | null): boolean => {
    if (!shouldStartUpdate(nodeUrl, pendingNodeRef.current)) return false;
    pendingNodeRef.current = nodeUrl;
    setPendingNodeUrl(nodeUrl);
    return true;
  }, []);

  /**
   * Refresh the card, the way the refresh button does.
   *
   * The pending state lasts as long as the read does, so the card says it
   * is working for as long as the node takes to answer.
   */
  const refreshCard = useCallback(() => {
    if (chain !== "wart") {
      setHoldingsTick((tick) => tick + 1);
      return;
    }
    // An update already running for this node is not started again.
    if (!startUpdate(currentNodeRef.current)) return;
    updateBalance(true);
    updateBalanceUSD();
    setHoldingsTick((tick) => tick + 1);
  }, [chain, startUpdate, updateBalance, updateBalanceUSD]);

  /**
   * Move to the other family and refresh what the card shows.
   *
   * The read itself happens in the balance effect, which re-runs when the
   * selected node changes. This cannot fetch: the state has not changed
   * yet, so it would read the node being left. The pending state is set
   * by that effect, once it knows which node the wallet landed on.
   */

  // Read the balance when the node changes.
  //
  // This is where the update of a switched-to node starts: the switch
  // itself cannot fetch, because at that moment the state has not changed
  // and it would read the node being left. Here the new node is known, so
  // the update is assigned to it and the card is pending for it.
  //
  // An update that is already running for this node is not started again,
  // so toggling back to a node that is still being read does not queue a
  // second read of it.
  useEffect(() => {
    if (!wallet || chain !== "wart" || view !== "wallet") return;
    const nodeUrl = selectedNode?.url ?? null;
    if (!nodeUrl) return;
    if (!shouldStartUpdate(nodeUrl, pendingNodeRef.current)) return;
    pendingNodeRef.current = nodeUrl;
    setPendingNodeUrl(nodeUrl);
    void updateBalance(true);
  }, [wallet, chain, view, selectedNode?.url, updateBalance]);

  useEffect(() => {
    if (wallet && chain === "wart" && view === "wallet") {
      updateBalanceUSD();
      const intervalIdPrice = setInterval(updateBalanceUSD, 60000);
      // A poll is a background refresh, not something the user asked for,
      // so it does not own the pending state.
      const intervalId = setInterval(() => void updateBalance(false), 15000);
      return () => {
        clearInterval(intervalIdPrice);
        clearInterval(intervalId);
      };
    }
  }, [wallet, chain, view, selectedToken, selectedNodeIndex, updateBalance, updateBalanceUSD]);

  const renderTabContent = () => {
    switch (activeTab) {
      case Tab.Actions: {
        const showAmount = (value: string) =>
          formatDisplayNumber(value, loadNumberDisplayPrefs(), { fallback: value || "0" });
        const usd = balance * balanceUSD;
        return (
          <div className="space-y-4">
            <div className="home-wallet-card">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-zinc-500">Available balance</span>
                  {chain === "wart" ? (
                    <NetworkBadge
                      network={network.id === "wart-testnet" ? "defi-testnet" : "mainnet"}
                      onSwitch={() => setNetwork(network.id === "wart-testnet" ? "wart-mainnet" : "wart-testnet")}
                    />
                  ) : null}
                </div>
                <button
                  type="button"
                  className="main-balance-refresh"
                  disabled={refreshing}
                  onClick={refreshCard}
                >
                  <span className="text-[#FDB913]">{refreshing ? "…" : "⟳"}</span>
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {chain === "wart" || !accounts ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {selectedToken.hash ? (
                        <AssetMark hash={selectedToken.hash} name={selectedToken.name} round />
                      ) : (
                        <TokenMark symbol="WART" size={28} />
                      )}
                      <p className="min-w-0 truncate text-sm font-semibold text-white">
                        {selectedToken.hash ? (
                          <AssetTitle hash={selectedToken.hash} name={selectedToken.name} />
                        ) : "WART"}
                      </p>
                    </div>
                    <p className="bal-color font-mono text-sm font-semibold">
                      {showAmount(wartSpend.available || "0")}
                    </p>
                  </div>
                  {!selectedToken.hash && hasPositiveLocked(wartSpend.locked) ? (
                    <p className="text-[11px] text-zinc-500">
                      Locked <span className="bal-color">{showAmount(wartSpend.locked)}</span>
                      {" · "}Total <span className="bal-color">{showAmount(wartSpend.total)}</span>
                    </p>
                  ) : null}
                  {!selectedToken.hash && activeNetwork === "mainnet" && usd > 0 ? (
                    <p className="num-color font-mono text-sm">≈ {showAmount(String(usd))} USD</p>
                  ) : null}
                  <NodeError message={balanceError} />
                  {/* The family has no node at all, so the picker is the
                      way out of it. */}
                  {nodeError ? (
                    <NodeError
                      message={nodeError}
                      linkLabel="Choose a node"
                      alwaysLink
                    />
                  ) : null}
                  {isPlainHttpNode(nodeList[selectedNodeIndex]?.url) ? (
                    <p className="text-xs text-amber-300">
                      This node uses plain HTTP. Someone on the network can read, reorder, or drop the transactions you submit.
                    </p>
                  ) : null}
                  {activeNetwork === "defi-testnet" && <TokenSelector
                    selectedToken={selectedToken}
                    onSelect={selectToken}
                    nodeUrl={nodeList[selectedNodeIndex]?.url || ""}
                    defi={activeNetwork === "defi-testnet"}
                  />}
                  {chains.length < 2 && !phrasePending ? (
                    <p className="text-[11px] text-zinc-500">
                      {ledgerAccount
                        ? "This Ledger session is the Warthog account. Other networks sign in the phone app."
                        : "Bitcoin, Ethereum, Hemi, and Solana come from the recovery phrase. A private-key import only has the Warthog account."}
                    </p>
                  ) : null}
                </>
              ) : (
                <ChainHoldings
                  chain={chain}
                  ethAddress={accounts.ethAddress}
                  btcAddress={accounts.btcAddress}
                  solAddress={accounts.solAddress}
                  refreshTick={holdingsTick}
                />
              )}
            </div>
            <div className={`wallet-actions${chain === "wart" && network.id === "wart-testnet" ? " wallet-actions--quad" : ""}`}>
              <button type="button" onClick={() => navigate(chain === "wart" ? "/send" : "/chain-send")}>
                <IoSend />
                Send
              </button>
              {chain === "wart" && network.id === "wart-testnet" ? (
                <>
                  <button type="button" onClick={() => navigate("/swap")}>
                    <IoTrendingUp />
                    Swap
                  </button>
                  <button type="button" onClick={() => navigate("/liquidity")}>
                    <IoWater />
                    Liquidity
                  </button>
                  <button type="button" onClick={() => navigate("/create-token")}>
                    <IoDiamond />
                    Mint
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => navigate("/receive")}>
                    <IoDownloadOutline />
                    Receive
                  </button>
                  {chain !== "wart" && network.capabilities.includes("swap") ? (
                    <button type="button" onClick={() => navigate("/swap")}>
                      <IoTrendingUp />
                      Swap
                    </button>
                  ) : null}
                </>
              )}
            </div>
            {network.id === "wart-testnet" && <WatchedAssets refreshTick={holdingsTick} />}
            {ledgerNote && (
              <p className="text-amber-200/90 text-xs text-center px-2">{ledgerNote}</p>
            )}
          </div>
        );
      }

      case Tab.History:
        return (
          <TransactionHistoryPanel
            wallet={wallet}
            node={nodeList[selectedNodeIndex] || null}
            active
            onActivityClick={openActivity}
          />
        );

      case Tab.Pending:
        return (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {pendingTxs.length === 0 && !pendingLoading && (
              <div className="text-center text-white/50 py-8">
                No pending transactions
              </div>
            )}
            {pendingTxs.map((item, idx) => (
              <PendingTxRow
                key={item.transaction?.hash || idx}
                type={item.type}
                tx={item.transaction ?? {}}
                onCancel={network.capabilities.includes("orders") && !ledgerAccount ? handleCancel : undefined}
              />
            ))}
            {pendingLoading && (
              <div className="flex justify-center py-4">
                <FaSync className="animate-spin text-white/50" size={20} />
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="container min-h-screen">
      {showApprovalBanner && pendingApproval && (
        <div className="p-4 bg-primary/20 border border-primary/50 rounded-lg mb-4">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-white font-semibold">
                {pendingApproval.action === 'requestAccounts' ? 'Connect Wallet Request' : pendingApproval.action === 'openSendPage' ? 'Send Request' : 'Transaction Request'}
              </p>
              <p className="text-white/50 text-sm">{pendingApproval.origin}</p>
            </div>
            <button
              onClick={handleReject}
              className="text-white/50 hover:text-white"
            >
              <IoCloseCircleOutline size={24} />
            </button>
          </div>
          <SenderSummary />
          {ledgerNote && <p className="text-xs text-amber-200 mt-2">{ledgerNote}</p>}
          {pendingApproval.to && (
            <p className="text-white/70 text-sm mb-2">To: {pendingApproval.to}</p>
          )}
          {pendingApproval.amount && (
            <p className="text-white/70 text-sm mb-2">Amount: {pendingApproval.amount} WART</p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleReject}
              className="flex-1 px-4 py-2 border border-white/30 text-white rounded-lg hover:bg-white/10"
            >
              Reject
            </button>
            <button
              onClick={handleApprove}
              disabled={approvalBusy}
              className="flex-1 px-4 py-2 bg-primary text-black font-semibold rounded-lg hover:bg-primary/80 disabled:opacity-60"
            >
              {pendingApproval.action === 'requestAccounts' ? 'Connect' : pendingApproval.action === 'openSendPage' ? 'Send' : 'Approve'}
            </button>
          </div>
        </div>
      )}

      <h1 className="wallet-page-title">{view === "activity" ? "Activity" : "Wallet"}</h1>
      {view === "activity" && chain === "wart" && <div className="defi-subtabs">
        <button className={`defi-compact-btn ${!showOrders && activeTab === Tab.History ? "defi-compact-btn-active" : ""}`} onClick={() => { setShowOrders(false); setActiveTab(Tab.History); }}>History</button>
        <button className={`defi-compact-btn ${!showOrders && activeTab === Tab.Pending ? "defi-compact-btn-active" : ""}`} onClick={() => { setShowOrders(false); setActiveTab(Tab.Pending); }}>Pending</button>
        {network.id === "wart-testnet" && <button className={`defi-compact-btn ${showOrders ? "defi-compact-btn-active" : ""}`} onClick={() => setShowOrders(true)}>Open orders</button>}
      </div>}

      <div className="mt-4">
        {chain !== "wart" && !accounts ? <p role={addressError ? "alert" : "status"}>{addressError || "Loading account addresses…"}</p>
          : view === "activity" && chain !== "wart" && accounts ? <ChainActivity chain={chain} address={address} ethAddress={accounts.ethAddress} btcAddress={accounts.btcAddress} solAddress={accounts.solAddress} />
          : showOrders ? <OpenOrders /> : renderTabContent()}
      </div>

      {showCancelModal && cancelTx && (
        <CancelConfirmModal
          tx={cancelTx}
          type={cancelType}
          onCancel={() => {
            setShowCancelModal(false);
            setCancelTx(null);
          }}
        />
      )}
    </div>
  );
};

export default Home;
