import { useEffect, useState } from "react";
import useWallet from "../hooks/useWallet";
import { setSessionAccountIndex } from "../mobile-port/utils/sessionVault";
import { chainPublicFromWorker } from "../utils/signingBridge";
import { WALLET_NETWORKS, type WalletNetworkId, type BrowserChain } from "../config/walletNetworks";
export type { BrowserChain } from "../config/walletNetworks";

const KEY = "warthogBrowserChain";
const EVENT = "warthog-chain";
const ORDER: BrowserChain[] = ["wart", "ethereum", "bitcoin", "hemi", "solana"];

export const CHAIN_LABEL: Record<BrowserChain, string> = {
  wart: "Warthog",
  ethereum: "Ethereum",
  bitcoin: "Bitcoin",
  hemi: "Hemi",
  solana: "Solana",
};

type ChainAccounts = {
  ethAddress: string;
  btcAddress: string;
  solAddress: string;
};

function readChain(): BrowserChain {
  const saved = localStorage.getItem(KEY);
  return ORDER.includes(saved as BrowserChain) ? (saved as BrowserChain) : "wart";
}

export function useChainAccounts(syncSession = false) {
  const { canAddAccounts, signingUnlocked, selectedWalletIndex, wallet, token, activeNetwork, setActiveNetwork } = useWallet();
  const accountKey = signingUnlocked && canAddAccounts && wallet
    ? JSON.stringify([token, wallet, selectedWalletIndex]) : null;
  const [result, setResult] = useState<{ key: string; accounts: ChainAccounts | null; error: string | null } | null>(null);
  // Effects run after render. Bind every result to its account/session so the
  // first render after a switch cannot expose the previous account's address.
  const current = accountKey && result?.key === accountKey ? result : null;
  const accounts = current?.accounts ?? null;
  const addressError = current?.error ?? null;

  useEffect(() => {
    if (!syncSession) return;
    setSessionAccountIndex(signingUnlocked ? selectedWalletIndex : 0);
  }, [syncSession, signingUnlocked, selectedWalletIndex]);

  useEffect(() => {
    if (!accountKey) {
      setResult(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const pubs = await chainPublicFromWorker(selectedWalletIndex);
        if (!pubs) throw new Error("No public addresses returned");
        if (!alive) return;
        setResult({ key: accountKey, error: null, accounts: {
          ethAddress: pubs.ethAddress, btcAddress: pubs.btcAddress, solAddress: pubs.solAddress,
        } });
      } catch {
        if (alive) setResult({ key: accountKey, accounts: null, error: "Could not load this account's addresses. Lock and unlock the wallet to try again." });
      }
    })();
    return () => {
      alive = false;
    };
  }, [accountKey, selectedWalletIndex]);

  // Network availability depends on the wallet type, not request timing.
  const chains: BrowserChain[] = accountKey ? ORDER : ["wart"];

  const [chain, setChainState] = useState<BrowserChain>(readChain);

  useEffect(() => {
    const sync = () => setChainState(readChain());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);

  const active = chains.includes(chain) ? chain : "wart";

  const setChain = (next: BrowserChain) => {
    localStorage.setItem(KEY, next);
    setChainState(next);
    window.dispatchEvent(new Event(EVENT));
  };

  const networkId: WalletNetworkId = active === "wart"
    ? activeNetwork === "defi-testnet" ? "wart-testnet" : "wart-mainnet"
    : active;
  const network = WALLET_NETWORKS.find((item) => item.id === networkId)!;
  const networks = WALLET_NETWORKS.filter((item) => chains.includes(item.chain));
  const setNetwork = (id: WalletNetworkId) => {
    const next = networks.find((item) => item.id === id);
    if (!next) return;
    if (next.chain === "wart") setActiveNetwork(id === "wart-testnet" ? "defi-testnet" : "mainnet");
    setChain(next.chain);
  };
  const address = active === "wart" ? wallet || "" : active === "bitcoin"
    ? accounts?.btcAddress || "" : active === "solana" ? accounts?.solAddress || "" : accounts?.ethAddress || "";
  const phrasePending = Boolean(accountKey && !current);
  return { accounts, chains, chain: active, setChain, phrasePending, addressError, network, networks, setNetwork, address };
}
