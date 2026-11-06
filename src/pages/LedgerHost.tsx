/**
 * Ledger step that survives the toolbar popup closing.
 * Connect reads the address. Sign approves one WART transfer already prepared
 * on the send screen.
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import LedgerWindowSetting from "../components/LedgerWindowSetting";
import useWallet from "../hooks/useWallet";
import { ledgerWartSubmitJson, signWartTransferOnLedger } from "../ledger/warthogApp";
import {
  clearLedgerSignJob,
  readLedgerSignJob,
  saveLedgerLastTx,
  type LedgerWindowMode,
} from "../ledger/session";
import { finishLedgerDeviceStep, markLedgerShell } from "../ledger/shell";
import { submitTransaction } from "../utils";
import { approveRequest } from "../utils/extensionApi";
import { hostBrowserName } from "../utils/browserName";
import type { PathType } from "../utils/walletKeys";

function LedgerHost() {
  const browserName = hostBrowserName();
  const { loginWithLedger, ledgerAccount, nodeList, sessionReady } = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const op = params.get("op") === "sign" ? "sign" : "connect";
  const pathType: PathType =
    params.get("path") === "non-hardened" ? "non-hardened" : "hardened";
  const accountName = params.get("name")?.trim() || "Ledger";
  const indexParam = Number(params.get("index"));
  const accountIndex =
    Number.isFinite(indexParam) && indexParam >= 0 ? Math.floor(indexParam) : 0;
  const expectedAddress = params.get("address")?.trim() || undefined;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [windowMode, setWindowMode] = useState<LedgerWindowMode>("dropdown");
  const onWindowMode = useCallback((next: LedgerWindowMode) => {
    setWindowMode(next);
  }, []);

  useEffect(() => {
    markLedgerShell();
  }, []);

  useEffect(() => {
    if (op !== "sign") return;
    void readLedgerSignJob().then((job) => {
      if (!job) {
        setError("This sign request expired. Close the window and send again.");
        return;
      }
      const amount = Number(job.amountE8) / 1e8;
      const fee = Number(job.feeE8) / 1e8;
      setSummary(
        `${amount} WART to ${job.toAddress.slice(0, 8)}…${job.toAddress.slice(-6)}, fee ${fee} WART`,
      );
    });
  }, [op]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithLedger(pathType, accountName, accountIndex, expectedAddress);
      await finishLedgerDeviceStep(() => navigate("/home", { replace: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ledger login failed");
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await readLedgerSignJob();
      if (!job) throw new Error("This sign request expired. Send again from the wallet.");
      if (!ledgerAccount) {
        throw new Error("Connect the Ledger from the start screen first.");
      }
      const tx = await signWartTransferOnLedger(ledgerAccount, {
        pinHash: job.pinHash,
        pinHeight: job.pinHeight,
        nonceId: job.nonceId,
        feeE8: BigInt(job.feeE8),
        toAddress: job.toAddress,
        amountE8: BigInt(job.amountE8),
      });
      const nodeIndex =
        job.nodeIndex >= 0 && job.nodeIndex < nodeList.length ? job.nodeIndex : 0;
      const hash = await submitTransaction(
        nodeList,
        nodeIndex,
        ledgerWartSubmitJson(tx, nodeList[nodeIndex]),
      );
      await clearLedgerSignJob();
      await saveLedgerLastTx(hash);
      setTxHash(hash);
      if (job.approveDapp) {
        if (!job.approvalId || !await approveRequest(job.approvalId, undefined, hash)) {
          throw new Error("Transaction broadcast, but the site did not receive its result. Check activity before retrying.");
        }
      }
      await finishLedgerDeviceStep(() => navigate("/home", { replace: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ledger sign failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container min-h-screen flex flex-col py-4">
      <div className="flex justify-center items-center pt-1 pb-3">
        <img src="/fullLogo.png" alt="WARTHOG NETWORK" className="max-h-24 object-contain" />
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-white/40 text-[11px] uppercase tracking-wide">Ledger</p>
        <h1 className="text-white text-xl font-semibold">
          {op === "sign" ? "Approve the transfer" : "Connect Ledger"}
        </h1>
        <p className="text-white/55 text-xs leading-relaxed">
          {op === "sign"
            ? windowMode === "sidepanel"
              ? `${browserName} asks for the Nano S+. Confirm the amount, fee, and recipient on the device. The Warthog app must be open. The wallet then opens in the side panel.`
              : `Leave this tab open. ${browserName} asks for the Nano S+. Confirm the amount, fee, and recipient on the device. The Warthog app must be open. This tab then closes and the wallet opens under the toolbar icon.`
            : windowMode === "sidepanel"
              ? `Unlock the Nano and open the Warthog app. ${browserName} lists the Nano S+. Choose it and click Connect. After you approve the address, the wallet opens in the side panel.`
              : `Unlock the Nano and open the Warthog app. ${browserName} lists the Nano S+. Choose it and click Connect. After you approve the address, this tab closes and the wallet opens under the toolbar icon.`}
        </p>
        {summary && <p className="text-white text-sm break-all">{summary}</p>}
        {txHash && (
          <p className="text-emerald-400 text-xs break-all">Broadcast {txHash}</p>
        )}
        {error && (
          <p className="text-red-400 text-sm" role="alert">
            {error}
          </p>
        )}
        {!txHash && (
          <Button
            variant="primary"
            className="w-full"
            disabled={busy || (op === "sign" && !sessionReady)}
            onClick={() => void (op === "sign" ? sign() : connect())}
          >
            {busy
              ? "Waiting for the Ledger…"
              : op === "sign"
                ? "Sign on Ledger"
                : "Connect Ledger"}
          </Button>
        )}
        <LedgerWindowSetting onChange={onWindowMode} />
      </div>
    </div>
  );
}

export default LedgerHost;
