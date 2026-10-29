import { useCallback, useEffect, useState } from "react";
import { probeSafeTradeForwarder, type ForwarderProbe } from "../mobile-port/utils/exchange/ipv4Host";

const DOT: Record<ForwarderProbe["state"] | "checking", string> = {
  checking: "bg-zinc-400",
  connected: "bg-emerald-400",
  forbidden: "bg-amber-400",
  missing: "bg-red-400",
  failed: "bg-red-400",
  unavailable: "bg-zinc-500",
};

const TITLE: Record<ForwarderProbe["state"] | "checking", string> = {
  checking: "Checking the forwarder",
  connected: "Forwarder connected",
  forbidden: "This extension is not allowed",
  missing: "Forwarder is not installed",
  failed: "Forwarder did not start",
  unavailable: "Forwarder is extension-only",
};

export default function ForwarderCard() {
  const [probe, setProbe] = useState<ForwarderProbe | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(() => {
    setChecking(true);
    void probeSafeTradeForwarder().then((next) => {
      setProbe(next);
      setChecking(false);
    });
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const state = checking ? "checking" : (probe?.state ?? "failed");

  return (
    <section className="rounded-lg border border-white/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold tracking-[1.2px] text-zinc-500 uppercase">IPv4 forwarder</p>
        <button
          type="button"
          className="text-[11px] text-white/50 disabled:opacity-50"
          onClick={check}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      <p className="mt-1 flex items-center gap-2 text-sm text-white">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} />
        {TITLE[state]}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-white/60">
        {checking
          ? "Asking Brave to start the local host. This check does not call SafeTrade."
          : probe?.detail}
      </p>
      {probe?.browserMessage && !checking ? (
        <p className="mt-1 text-[11px] leading-relaxed text-white/35">{probe.browserMessage}</p>
      ) : null}
      {probe?.extensionId ? (
        <p className="mt-2 text-[11px] text-white/45">
          Extension id
          <span className="mt-0.5 block font-mono break-all text-zinc-200">{probe.extensionId}</span>
        </p>
      ) : null}
    </section>
  );
}
