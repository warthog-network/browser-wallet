import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { IoCopyOutline, IoLockClosedOutline, IoQrCodeOutline, IoSettingsOutline } from "react-icons/io5";
import Jazzicon from "react-jazzicon";
import useWallet from "../hooks/useWallet";
import { useChainAccounts } from "../chains/useChainAccounts";
import { addressToSeed } from "../utils";
import { toast } from "../utils/toast";
import type { WalletNetworkId } from "../config/walletNetworks";
import TickerMenu from "./TickerMenu";

function AccountMenu({
  names,
  addresses,
  selected,
  busy,
  onSelect,
  onManage,
}: {
  names: string[];
  addresses: string[];
  selected: number;
  busy: boolean;
  onSelect: (index: number) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const index = addresses.length && selected >= 0 && selected < addresses.length ? selected : 0;
  const label = names[index] || `Account ${index}`;
  const address = addresses[index] || "";
  const iconSeed = (value: string) => {
    const seed = addressToSeed(value || "");
    return Number.isFinite(seed) ? seed : 0;
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`ticker-menu ticker-menu--account${open ? " ticker-menu--open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="ticker-menu-btn"
        aria-label="Account"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="account-mark"><Jazzicon diameter={22} seed={iconSeed(address)} /></span>
        <span className="ticker-menu-copy"><span>{label}</span></span>
        <span className="ticker-menu-chevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="ticker-menu-panel">
          <div className="ticker-menu-list" id={listId} role="listbox" aria-label="Account">
            {addresses.map((item, row) => {
              const on = row === index;
              const name = names[row] || `Account ${row}`;
              return (
                <button
                  key={`${row}:${item}`}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`ticker-menu-option${on ? " ticker-menu-option--active" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    if (!on) onSelect(row);
                  }}
                >
                  <span className="account-mark"><Jazzicon diameter={26} seed={iconSeed(item)} /></span>
                  <span className="ticker-menu-copy">
                    <span>{name}</span>
                    <small>{item ? `${item.slice(0, 6)}…${item.slice(-4)}` : ""}</small>
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className="ticker-menu-option"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              <span className="account-mark" aria-hidden="true" />
              <span className="ticker-menu-copy"><span>Manage accounts…</span></span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function AppHeader() {
  const { nameList, walletList, selectedWalletIndex, switchActiveAccount, lockSession, activeNetwork } = useWallet();
  const { network, networks, setNetwork, address } = useChainAccounts();
  const networkItems = networks.reduce<{ id: string; label: string; symbol: string }[]>((items, item) => {
    if (item.chain === "wart") {
      if (!items.some((row) => row.id === "wart")) items.push({ id: "wart", label: "Warthog", symbol: item.symbol });
      return items;
    }
    items.push({ id: item.id, label: item.label, symbol: item.symbol });
    return items;
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  const onSettings = location.pathname === "/settings";
  const [gearTurns, setGearTurns] = useState(0);
  const wasSettings = useRef(onSettings);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (wasSettings.current === onSettings) return;
    wasSettings.current = onSettings;
    setGearTurns((turns) => turns + 1);
  }, [onSettings]);
  const switchAccount = async (index: number) => {
    setBusy(true);
    try {
      await switchActiveAccount(index);
      navigate("/home");
    } catch (error) {
      toast.error("Account switch failed", error instanceof Error ? error.message : "Try again");
    } finally { setBusy(false); }
  };
  return (
    <header className="wallet-header">
      <div className="wallet-header-row">
        <AccountMenu
          names={nameList}
          addresses={walletList}
          selected={selectedWalletIndex}
          busy={busy}
          onSelect={(index) => void switchAccount(index)}
          onManage={() => navigate("/manage-account")}
        />
        <button className="wallet-icon-button" aria-label="Lock wallet" title="Lock wallet" onClick={() => void lockSession().then(() => navigate("/login-saved"))}><IoLockClosedOutline /></button>
        <button className="wallet-icon-button" aria-label={onSettings ? "Close settings" : "Settings"} title={onSettings ? "Close settings" : "Settings"} onClick={() => navigate(onSettings ? "/home" : "/settings")}><IoSettingsOutline className="wallet-gear" style={{ transform: `rotate(${gearTurns * 360}deg)` }} /></button>
      </div>
      <div className="wallet-header-row wallet-network-row">
        <TickerMenu
          className="ticker-menu--header"
          ariaLabel="Network"
          value={network.chain === "wart" ? "wart" : network.id}
          onChange={(id) => {
            const next = id === "wart"
              ? (activeNetwork === "defi-testnet" ? "wart-testnet" : "wart-mainnet")
              : id as WalletNetworkId;
            setNetwork(next);
            navigate("/home");
          }}
          items={networkItems}
        />
        <button className="wallet-address-copy" disabled={busy || !address} title={address || "Loading address"} aria-label="Copy address" onClick={() => {
          void navigator.clipboard.writeText(address).then(() => toast.success("Address copied", network.label)).catch(() => toast.error("Copy failed", "Try again"));
        }}><span>{address ? `${address.slice(0, 5)}…${address.slice(-4)}` : "…"}</span><IoCopyOutline /></button>
        <button className="wallet-icon-button" disabled={busy || !address} aria-label="Receive, show QR code" title="Receive" onClick={() => navigate("/receive")}><IoQrCodeOutline /></button>
      </div>
    </header>
  );
}
