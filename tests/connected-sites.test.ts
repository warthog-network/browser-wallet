import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Message = { action: string; origin?: string; payload?: { txHash?: string } };
type Sender = { url: string; tab?: { id: number } };
type Listener = (message: Message, sender: Sender, reply: (response: unknown) => void) => Promise<unknown> | undefined;

function background() {
  let listener: Listener;
  const stored: Record<string, unknown> = {};
  const events: { tabId: number; message: unknown }[] = [];
  const sandbox = {
    URL,
    console: { log() {}, warn() {}, error() {} },
    browser: {
      runtime: { getURL: (path: string) => `chrome-extension://wallet/${path}`, onMessage: { addListener: (fn: Listener) => { listener = fn; } } },
      storage: { local: {
        set: async (data: Record<string, unknown>) => { Object.assign(stored, data); },
        remove: async (key: string) => { delete stored[key]; },
      } },
      tabs: {
        query: async () => [{ id: 1, url: "https://app.example/trade" }, { id: 2, url: "https://other.example/" }],
        sendMessage: async (tabId: number, message: unknown) => { events.push({ tabId, message }); },
      },
    },
  };
  const source = readFileSync(new URL("../public/background.js", import.meta.url), "utf8");
  runInNewContext(source.replace("new WarthogBackground();", `
    const instance = Object.create(WarthogBackground.prototype);
    instance.connections = new Map([['https://app.example', { accounts: ['account-0'], chainId: '0x539' }]]);
    instance.ready = Promise.resolve();
    instance.setupMessageListener();
  `), sandbox);
  return {
    stored, events,
    async send(message: Message, sender: Sender = { url: "chrome-extension://wallet/index.html" }) {
      let reply: unknown;
      const result = listener!(message, sender, (response) => { reply = response; });
      return result ? await result : reply;
    },
  };
}

describe("connected-site administration", () => {
  test("extension pages can list granted accounts", async () => {
    const app = background();
    expect(await app.send({ action: "walletListConnections" })).toEqual([{ origin: "https://app.example", accounts: ["account-0"] }]);
  });
  test("revocation persists and notifies only that site's tabs", async () => {
    const app = background();
    await app.send({ action: "walletRevokeConnection", origin: "https://app.example" });
    expect(await app.send({ action: "walletListConnections" })).toEqual([]);
    expect(JSON.parse(app.stored.connections as string)).toEqual({});
    expect(app.events).toEqual([{ tabId: 1, message: { type: "WARTHOG_PROVIDER_EVENT", action: "accountsChanged", data: [] } }]);
  });
  test("website content scripts cannot list or revoke connections", async () => {
    const app = background();
    const sender = { url: "https://app.example/", tab: { id: 1 } };
    expect(await app.send({ action: "walletListConnections" }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "walletRevokeConnection", origin: "https://app.example" }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "walletListConnections" })).toHaveLength(1);
  });
  test("a web page cannot approve, reject, or read a pending request", async () => {
    const app = background();
    const sender = { url: "https://app.example/", tab: { id: 1 } };
    expect(await app.send({ action: "approveRequest", payload: { txHash: "fake" } }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "rejectRequest" }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "deferApproval" }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "approvalResult", payload: { txHash: "fake" } }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "getPendingApproval" }, sender)).toEqual({ error: "Unauthorized" });
    expect(await app.send({ action: "showToolbarDropdown" }, sender)).toEqual({ error: "Unauthorized" });
  });
  test("an extension page can still reject a request", async () => {
    const app = background();
    expect(await app.send({ action: "rejectRequest" })).toEqual({ success: false });
  });
});
