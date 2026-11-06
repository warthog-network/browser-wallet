import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Approval = { approvalId: string; action: string; origin: string };
type Response = { tabId: number; requestId: number; success: boolean; error?: { code: number }; data?: unknown };
type BackgroundInstance = {
  handleRequestAccounts: (origin: string, tabId: number, requestId: number) => Promise<void>;
  handleSendTransaction: (payload: { to: string; amount: string }, origin: string, tabId: number, requestId: number) => Promise<void>;
  handleApproveRequest: (payload: { approvalId: string; accounts?: string[]; txHash?: string }) => boolean;
  deferApproval: (payload: { approvalId: string }) => boolean;
  pendingRequest?: { approvalId: string } | null;
};

function background() {
  let onRemoved: (windowId: number) => void = () => {};
  let nextId = 0;
  const stored: Record<string, unknown> = {};
  const responses: Response[] = [];
  const sandbox = {
    crypto: { randomUUID: () => `approval-${++nextId}` },
    console: { log() {}, warn() {}, error() {} },
    browser: {
      storage: { local: {
        set: async (data: Record<string, unknown>) => { Object.assign(stored, data); },
        remove: async (key: string) => { delete stored[key]; },
      } },
      windows: {
        onRemoved: { addListener(fn: (windowId: number) => void) { onRemoved = fn; } },
        async remove(windowId: number) { onRemoved(windowId); },
      },
    },
  };
  const source = readFileSync(new URL("../public/background.js", import.meta.url), "utf8");
  const context = { ...sandbox, responses };
  runInNewContext(source.replace("new WarthogBackground();", `
    const instance = Object.create(WarthogBackground.prototype);
    instance.connections = new Map([
      ['https://a.example', { accounts: ['account-0'] }],
      ['https://b.example', { accounts: ['account-0'] }],
    ]);
    instance.focusOrCreatePopup = async () => ({ id: 44 });
    instance.sendResponse = (tabId, requestId, response) => responses.push({ tabId, requestId, ...response });
    instance.sendToTab = () => {};
    instance.saveConnections = () => {};
    instance.setupWindowListeners();
    globalThis.instance = instance;
  `), context);
  const instance = (context as typeof context & { instance: BackgroundInstance }).instance;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    instance, stored, responses, flush,
    closePopup: () => onRemoved(44),
    pending: () => JSON.parse(stored.pendingApproval as string) as Approval,
  };
}

describe("dApp approval ownership", () => {
  test("a second site cannot replace the displayed account request", async () => {
    const app = background();
    void app.instance.handleRequestAccounts("https://a.example", 1, 11);
    await app.flush();
    const first = app.pending();
    void app.instance.handleRequestAccounts("https://b.example", 2, 22);
    await app.flush();

    expect(app.pending()).toEqual(first);
    expect(app.responses).toContainEqual({ tabId: 2, requestId: 22, success: false, error: { code: -32002, message: "Another wallet approval is pending" } });
    expect(app.instance.handleApproveRequest({ approvalId: first.approvalId, accounts: ["account-0"] })).toBe(true);
    await app.flush();
    expect(app.responses).toContainEqual({ tabId: 1, requestId: 11, success: true, data: { accounts: ["account-0"] } });
  });

  test("an old approval cannot resolve the next transaction", async () => {
    const app = background();
    void app.instance.handleSendTransaction({ to: "recipient-a", amount: "1" }, "https://a.example", 1, 11);
    await app.flush();
    const first = app.pending();
    void app.instance.handleSendTransaction({ to: "recipient-b", amount: "2" }, "https://b.example", 2, 22);
    await app.flush();
    expect(app.responses.at(-1)).toMatchObject({ tabId: 2, requestId: 22, success: false, error: { code: -32002 } });

    expect(app.instance.handleApproveRequest({ approvalId: first.approvalId, txHash: "hash-a" })).toBe(true);
    await app.flush();
    void app.instance.handleSendTransaction({ to: "recipient-b", amount: "2" }, "https://b.example", 2, 23);
    await app.flush();
    const second = app.pending();
    expect(app.instance.handleApproveRequest({ approvalId: first.approvalId, txHash: "wrong-hash" })).toBe(false);
    expect(app.pending()).toEqual(second);
    expect(app.instance.handleApproveRequest({ approvalId: second.approvalId, txHash: "hash-b" })).toBe(true);
    await app.flush();
    expect(app.responses.at(-1)).toMatchObject({ tabId: 2, requestId: 23, success: true, data: { txHash: "hash-b" } });
  });

  test("Ledger handoff keeps the request alive when the popup closes", async () => {
    const app = background();
    void app.instance.handleSendTransaction({ to: "recipient", amount: "1" }, "https://a.example", 1, 11);
    await app.flush();
    const approval = app.pending();
    expect(app.instance.deferApproval({ approvalId: approval.approvalId })).toBe(true);
    app.closePopup();
    expect(app.instance.pendingRequest?.approvalId).toBe(approval.approvalId);
    expect(app.pending()).toEqual(approval);
    expect(app.responses).toEqual([]);

    expect(app.instance.handleApproveRequest({ approvalId: approval.approvalId, txHash: "ledger-hash" })).toBe(true);
    await app.flush();
    expect(app.responses.at(-1)).toMatchObject({ tabId: 1, requestId: 11, success: true, data: { txHash: "ledger-hash" } });
  });

  test("closing an ordinary approval still rejects it", async () => {
    const app = background();
    void app.instance.handleSendTransaction({ to: "recipient", amount: "1" }, "https://a.example", 1, 11);
    await app.flush();
    app.closePopup();
    await app.flush();
    expect(app.responses.at(-1)).toMatchObject({ tabId: 1, requestId: 11, success: false, error: { code: 4001 } });
    expect(app.stored.pendingApproval).toBeUndefined();
  });
});
