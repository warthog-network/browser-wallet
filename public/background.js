const CHAIN_ID = '0x539';

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Unauthorized - please connect first' },
  CHAIN_NOT_FOUND: { code: 4900, message: 'Chain not found' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
};

class WarthogBackground {
  constructor() {
    this.connections = new Map();
    this.pendingRequest = null;
    this.approvalWindowId = null;
    this.pendingPopupPromise = null;
    this.ready = this.restoreConnections();
    this.setupMessageListener();
    this.setupWindowListeners();
    this.applyLedgerWindow();
  }

  // Chrome runs MV3 background code as a service worker, which it terminates
  // after ~30s idle. Anything held only on `this` dies with it, so connected
  // dapps would silently fall back to "not connected" after any cold start.
  // Mirror `connections` into storage.local and rehydrate on every boot.
  async restoreConnections() {
    try {
      const stored = await browser.storage.local.get('connections');
      const parsed = stored?.connections ? JSON.parse(stored.connections) : {};
      this.connections = new Map(Object.entries(parsed));
      console.log('Restored connections:', [...this.connections.keys()]);
    } catch (error) {
      console.error('Failed to restore connections:', error);
      this.connections = new Map();
    }
  }

  saveConnections() {
    browser.storage.local
      .set({ connections: JSON.stringify(Object.fromEntries(this.connections)) })
      .catch((error) => console.error('Failed to persist connections:', error));
  }

  async applyLedgerWindow() {
    let mode = 'dropdown';
    try {
      const stored = await browser.storage.local.get('warthogLedgerWindow');
      const value = stored && stored.warthogLedgerWindow;
      if (value === 'sidepanel' || value === 'tab') mode = 'sidepanel';
    } catch (err) {
      console.warn('ledger window read failed', err);
    }
    // Firefox has one wallet view: the sidebar. The toolbar icon opens and
    // closes it, so the icon must not also load the popup page.
    if (browser.sidebarAction) {
      this.mode = 'sidepanel';
      try {
        await this.attachFirefoxToolbarAction();
      } catch (err) {
        console.warn('firefox toolbar action setup failed', err);
      }
      return;
    }
    this.mode = mode;
    const chromeApi = globalThis.chrome;
    const sidePanel = chromeApi && chromeApi.sidePanel;
    const action = chromeApi && chromeApi.action;
    try {
      if (mode === 'sidepanel') {
        if (action && action.setPopup) await action.setPopup({ popup: '' });
        if (sidePanel && sidePanel.setOptions) {
          await sidePanel.setOptions({ path: 'index.html?sidepanel=1', enabled: true });
        }
        if (sidePanel && sidePanel.setPanelBehavior) {
          await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        }
        return;
      }
      if (sidePanel && sidePanel.setPanelBehavior) {
        await sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
      if (action && action.setPopup) await action.setPopup({ popup: 'index.html' });
    } catch (err) {
      console.warn('ledger window apply failed', err);
    }
  }

  /**
   * Firefox. Clear the manifest popup so a toolbar click reaches onClicked,
   * then toggle the sidebar from it. Toggling keeps the second click closing
   * the wallet, like a dropdown would.
   */
  async attachFirefoxToolbarAction() {
    const action = browser.action;
    if (action && action.setPopup) {
      try {
        await action.setPopup({ popup: '' });
      } catch (err) {
        console.warn('toolbar popup clear failed', err);
      }
    }
    if (this.firefoxToolbarBound) return;
    this.firefoxToolbarBound = true;
    if (action && action.onClicked) {
      action.onClicked.addListener(() => {
        this.toggleFirefoxSidebar().catch((err) => {
          console.warn('sidebar toggle failed', err);
        });
      });
    }
  }

  async toggleFirefoxSidebar() {
    const sidebar = browser.sidebarAction;
    if (!sidebar) return;
    if (sidebar.toggle) {
      await sidebar.toggle();
      return;
    }
    if (sidebar.isOpen && (await sidebar.isOpen())) {
      if (sidebar.close) await sidebar.close();
      return;
    }
    if (sidebar.open) await sidebar.open();
  }

  /** Open the sidebar without closing it when it is already docked. */
  async focusFirefoxSidebar() {
    const sidebar = browser.sidebarAction;
    if (!sidebar) return;
    try {
      if (sidebar.isOpen && (await sidebar.isOpen())) return;
    } catch {
      // Unknown state; open anyway.
    }
    if (sidebar.open) await sidebar.open();
  }

  setupWindowListeners() {
    // default_popup owns the toolbar click. Do not also listen for onClicked.

    browser.windows.onRemoved.addListener((windowId) => {
      if (windowId === this.approvalWindowId) {
        console.log('Popup window closed, clearing approvalWindowId');
        this.approvalWindowId = null;
        if (this.pendingRequest) {
          console.log('Clearing pendingRequest due to popup close');
          if (this.pendingRequest.reject) {
            this.pendingRequest.reject(ERRORS.USER_REJECTED);
          }
          this.pendingRequest = null;
        }
        browser.storage.local.remove('pendingApproval');
      }
    });
  }

  setupMessageListener() {
    console.log('setupMessageListener registered');
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('background received message', { message, tabId: sender.tab?.id, url: sender.url });
      const tabId = sender.tab?.id;
      const url = sender.url || '';
      const origin = this.extractOrigin(url);

      // Approval and window control resolve a pending dApp request or open
      // the wallet. A content script's sender URL is the page, so these stay
      // on extension pages. The page relay also refuses to forward them.
      if (this.isPrivilegedAction(message.action) && !this.isExtensionSender(url)) {
        sendResponse({ error: 'Unauthorized' });
        return;
      }

      if (message.action === 'walletListConnections' || message.action === 'walletRevokeConnection') {
        return this.ready.then(async () => {
          if (message.action === 'walletListConnections') {
            return [...this.connections.entries()].map(([siteOrigin, connection]) => ({ origin: siteOrigin, accounts: connection.accounts || [] }));
          }
          const siteOrigin = message.origin;
          this.connections.delete(siteOrigin);
          if (this.pendingRequest?.origin === siteOrigin) {
            this.handleRejectRequest();
            await browser.storage.local.remove('pendingApproval');
          }
          await browser.storage.local.set({ connections: JSON.stringify(Object.fromEntries(this.connections)) });
          const tabs = await browser.tabs.query({});
          for (const tab of tabs) {
            if (tab.id != null && this.extractOrigin(tab.url || '') === siteOrigin) this.sendToTab(tab.id, 'accountsChanged', []);
          }
          return { success: true };
        });
      }

      if (message.action === 'approvalResult') {
        console.log('handling approvalResult:', message.payload);
        this.handleApprovalResult(message.payload);
        sendResponse({ success: true });
        return;
      }

      if (message.action === 'getPendingApproval') {
        console.log('handling getPendingApproval');
        this.handleGetPendingApproval();
        sendResponse({ success: true });
        return;
      }

      if (message.action === 'approveRequest') {
        console.log('handling approveRequest');
        this.handleApproveRequest(message.payload);
        sendResponse({ success: true });
        return;
      }

      if (message.action === 'rejectRequest') {
        console.log('handling rejectRequest');
        this.handleRejectRequest();
        sendResponse({ success: true });
        return;
      }

      if (message.action === 'reopenToolbarPopup') {
        sendResponse({ success: true });
        this.reopenToolbarAfter(message.windowId);
        return;
      }

      if (message.action === 'showToolbarDropdown') {
        return this.showToolbarDropdown();
      }

      if (message.action === 'extensionFetch') {
        return this.extensionFetch(message, sender);
      }

      if (message.action) {
        this.handleMessage(message, origin, tabId);
      }

      sendResponse({ success: true });
      return true;
    });
  }

  isExtensionSender(url) {
    if (!url) return false;
    try {
      return url.startsWith(browser.runtime.getURL(''));
    } catch (err) {
      return false;
    }
  }

  isPrivilegedAction(action) {
    return action === 'walletListConnections'
      || action === 'walletRevokeConnection'
      || action === 'approvalResult'
      || action === 'getPendingApproval'
      || action === 'approveRequest'
      || action === 'rejectRequest'
      || action === 'reopenToolbarPopup'
      || action === 'showToolbarDropdown';
  }

  extensionFetch(message, sender) {
    const senderUrl = (sender && sender.url) || '';
    const selfPrefix = browser.runtime.getURL('');
    if (!senderUrl.startsWith(selfPrefix)) {
      return Promise.resolve({ ok: false, error: 'Blocked' });
    }
    let target;
    try {
      target = new URL(message.url);
    } catch (err) {
      return Promise.resolve({ ok: false, error: 'Bad URL' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return Promise.resolve({ ok: false, error: 'Blocked' });
    }
    const headers = message.headers && typeof message.headers === 'object' ? message.headers : {};
    const method = typeof message.method === 'string' ? message.method : 'GET';
    return fetch(message.url, {
      method,
      headers,
      cache: 'no-store',
      body: typeof message.body === 'string' ? message.body : undefined,
    })
      .then(async (response) => {
        const text = await response.text();
        return { ok: response.ok, status: response.status, text };
      })
      .catch((err) => ({
        ok: false,
        error: String(err && err.message ? err.message : err),
      }));
  }

  reopenToolbarAfter(windowId) {
    if (this.toolbarReopenPending) return;
    if (browser.sidebarAction) {
      this.toolbarReopenPending = true;
      this.focusFirefoxSidebar()
        .catch((err) => console.warn('sidebar open failed:', err))
        .finally(() => {
          this.toolbarReopenPending = false;
        });
      return;
    }
    this.toolbarReopenPending = true;
    let done = false;
    const open = () => {
      if (done) return;
      done = true;
      browser.windows.onRemoved.removeListener(onRemoved);
      clearTimeout(this.toolbarReopenTimer);
      this.openToolbarDropdown()
        .catch((err) => {
          const msg = String(err && err.message ? err.message : err);
          console.warn('toolbar popup reopen failed:', msg);
          if (/already/i.test(msg)) return;
          return this.openToolbarCornerFallback();
        })
        .finally(() => {
          this.toolbarReopenPending = false;
        });
    };
    const onRemoved = (removedId) => {
      if (removedId !== windowId) return;
      setTimeout(open, 60);
    };
    if (typeof windowId === 'number') {
      browser.windows.onRemoved.addListener(onRemoved);
    }
    this.toolbarReopenTimer = setTimeout(open, 500);
  }

  async showToolbarDropdown() {
    if (this.toolbarDropdownPending) return { ok: true };
    this.toolbarDropdownPending = true;
    // Firefox: the toolbar and the sidebar are the same wallet view.
    if (browser.sidebarAction) {
      try {
        await this.focusFirefoxSidebar();
      } catch (err) {
        console.warn('sidebar open failed', err);
      } finally {
        this.toolbarDropdownPending = false;
      }
      return { ok: true };
    }
    const chromeApi = globalThis.chrome;
    try {
      await this.armLedgerPopupView();
      try {
        await browser.storage.local.set({ warthogLedgerWindow: 'dropdown' });
      } catch (err) {
        console.warn('dropdown mode save failed', err);
      }
      try {
        if (chromeApi && chromeApi.sidePanel && chromeApi.sidePanel.setPanelBehavior) {
          await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        }
        if (chromeApi && chromeApi.action && chromeApi.action.setPopup) {
          await chromeApi.action.setPopup({ popup: 'index.html' });
        }
      } catch (err) {
        console.warn('dropdown mode apply failed', err);
      }
      // The side panel closes itself on this click. Wait until that document
      // is gone. Opening sooner lets the close swallow the menu.
      await new Promise((resolve) => setTimeout(resolve, 280));
      let opened = false;
      try {
        await this.openToolbarDropdown();
        opened = true;
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/already/i.test(msg)) return { ok: true };
        console.warn('show toolbar dropdown failed:', msg);
      }
      if (opened) {
        const visible = await this.waitForExtensionPopup();
        if (visible !== false) return { ok: true };
        console.warn('openPopup resolved with no popup view');
      }
      await this.armLedgerPopupView();
      await this.openToolbarCornerFallback();
      return { ok: true };
    } finally {
      this.toolbarDropdownPending = false;
    }
  }

  async armLedgerPopupView() {
    try {
      const chromeApi = globalThis.chrome;
      const session = chromeApi && chromeApi.storage && chromeApi.storage.session;
      if (session && session.set) {
        await session.set({ warthogLedgerPopupArm: Date.now() });
      }
    } catch (err) {
      console.warn('ledger popup arm failed', err);
    }
  }

  /** true when a popup view exists, false when it does not, null if unknown. */
  async waitForExtensionPopup() {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || typeof runtime.getContexts !== 'function') return null;
    for (let i = 0; i < 5; i++) {
      try {
        const contexts = await runtime.getContexts({ contextTypes: ['POPUP'] });
        if (Array.isArray(contexts) && contexts.length > 0) return true;
      } catch {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return false;
  }

  async openToolbarDropdown() {
    const chromeAction = globalThis.chrome && globalThis.chrome.action;
    if (chromeAction && chromeAction.openPopup) {
      await chromeAction.openPopup();
      return;
    }
    if (browser.action && browser.action.openPopup) {
      await browser.action.openPopup();
      return;
    }
    throw new Error('openPopup unavailable');
  }

  async openToolbarCornerFallback() {
    const width = 440;
    const height = 680;
    let left;
    let top;
    try {
      const all = await browser.windows.getAll({ windowTypes: ['normal'] });
      const base =
        all.find((w) => w.focused && (w.width || 0) > 500) ||
        [...all].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      if (base && typeof base.width === 'number' && typeof base.left === 'number') {
        left = Math.max(0, Math.round(base.left + base.width - width - 8));
        top = Math.max(0, Math.round((base.top || 0) + 56));
      }
    } catch {
      // ignore
    }
    const url = browser.runtime.getURL('index.html') + '#/home';
    const created = await browser.windows.create({
      url,
      type: 'popup',
      width,
      height,
      focused: true,
      ...(left != null && top != null ? { left, top } : {}),
    });
    if (created && created.id != null && left != null && top != null) {
      try {
        await browser.windows.update(created.id, {
          left,
          top,
          width,
          height,
          focused: true,
        });
      } catch {
        // position is best-effort
      }
    }
  }

  extractOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return 'unknown';
    }
  }

  async findExistingPopup() {
    console.log('findExistingPopup called, approvalWindowId:', this.approvalWindowId);
    if (this.approvalWindowId) {
      try {
        const win = await browser.windows.get(this.approvalWindowId);
        console.log('browser.windows.get result:', win);
        if (win && win.id) {
          console.log('Found popup by approvalWindowId:', this.approvalWindowId);
          return win;
        }
      } catch (e) {
        console.log('Window get failed, clearing approvalWindowId');
        this.approvalWindowId = null;
      }
    }

    await new Promise(r => setTimeout(r, 50));
    const wins = await browser.windows.getAll({ windowTypes: ['popup'] });
    console.log('All popup windows:', wins.map(w => ({ id: w.id, url: w.url })));
    const extensionUrl = browser.runtime.getURL('');
    for (const win of wins) {
      if (win.url && win.url.startsWith(extensionUrl)) {
        console.log('Found existing extension popup by URL scan:', win.id);
        this.approvalWindowId = win.id;
        return win;
      }
    }
    console.log('No existing popup found');
    return null;
  }

  async popupBounds(width, height) {
    // Service workers have no `screen`. Center on the browser window instead
    // of letting Chrome drop the popup in the top-left corner.
    let anchor = null;
    try {
      const focused = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (focused && focused.type === 'normal' && focused.width > 500) anchor = focused;
    } catch (err) {
      console.warn('Could not read the focused window for centering:', err);
    }
    if (!anchor) {
      try {
        const all = await browser.windows.getAll({ windowTypes: ['normal'] });
        anchor = (all || [])
          .filter((w) => w.type === 'normal' && typeof w.width === 'number')
          .sort((a, b) => (b.width || 0) - (a.width || 0))[0] || null;
      } catch (err) {
        console.warn('Could not list windows for centering:', err);
      }
    }
    const bounds = { width, height };
    if (anchor && typeof anchor.left === 'number' && typeof anchor.width === 'number') {
      bounds.left = Math.max(0, Math.round(anchor.left + (anchor.width - width) / 2));
      bounds.top = Math.max(0, Math.round((anchor.top || 0) + ((anchor.height || height) - height) / 2));
    }
    return bounds;
  }

  async focusOrCreatePopup(url) {
    console.log('focusOrCreatePopup called with url:', url, 'pendingPopupPromise:', !!this.pendingPopupPromise);
    if (this.pendingPopupPromise) {
      console.log('Returning existing pendingPopupPromise');
      return this.pendingPopupPromise;
    }

    const existing = await this.findExistingPopup();
    if (existing) {
      this.approvalWindowId = existing.id;
      console.log('Found existing popup, focusing:', existing.id);
      await browser.windows.update(existing.id, { focused: true });
      return existing;
    }
    console.log('No existing popup, creating new');
    // Outer size is a bit larger than the 410×600 card so the window frame
    // does not eat the content area and clip the right edge.
    const width = 440;
    const height = 680;
    const bounds = await this.popupBounds(width, height);

    this.pendingPopupPromise = browser.windows.create({
      url,
      type: 'popup',
      focused: true,
      ...bounds,
    }).then(async (win) => {
      this.approvalWindowId = win?.id || null;
      // Linux Chrome often ignores left/top on create and parks the window
      // at 0,0. A follow-up update is what actually centers it.
      if (win?.id != null && bounds.left != null) {
        try {
          await browser.windows.update(win.id, {
            left: bounds.left,
            top: bounds.top,
            width,
            height,
            focused: true,
          });
        } catch (err) {
          console.warn('Could not center popup window:', err);
        }
      }
      return win;
    }).finally(() => {
      this.pendingPopupPromise = null;
    });
    return this.pendingPopupPromise;
  }

  async handleMessage(message, origin, tabId) {
    // Cold-start race: on a freshly woken service worker `connections` is still
    // being rehydrated from storage. Wait for it before any handler reads it.
    await this.ready;

    const { action, payload, id } = message;

    switch (action) {
      case 'requestAccounts':
        this.handleRequestAccounts(origin, tabId, id);
        break;
      case 'sendTransaction':
      case 'transferWart':
        this.handleSendTransaction(payload, origin, tabId, id);
        break;
      case 'openSendPage':
        this.handleOpenSendPage(payload, origin, tabId, id);
        break;
      case 'getAccounts':
        this.handleGetAccounts(origin, tabId, id);
        break;
      case 'getChainId':
        this.handleGetChainId(tabId, id);
        break;
      case 'disconnect':
        this.handleDisconnect(origin, tabId, id);
        break;
      case 'getConnectionState':
        this.handleGetConnectionState(origin, tabId, id);
        break;
      case 'getPendingApproval':
        this.handleGetPendingApproval(tabId, id);
        break;
      case 'approveRequest':
        this.handleApproveRequest(payload, tabId, id);
        break;
      case 'rejectRequest':
        this.handleRejectRequest(tabId, id);
        break;
    }
  }

  async handleRequestAccounts(origin, tabId, requestId) {
    console.log('handleRequestAccounts called', { origin, tabId, requestId });
    if (this.pendingRequest && this.pendingRequest.origin === origin) {
      console.log('Duplicate request from same origin, rejecting');
      this.sendResponse(tabId, requestId, { success: false, error: ERRORS.USER_REJECTED });
      return;
    }
    try {
      const result = await this.requestApproval({
        requestId,
        action: 'requestAccounts',
        origin,
        tabId,
      });
      console.log('requestApproval resolved', result);

      if (result.accounts && result.accounts.length > 0) {
        this.connections.set(origin, {
          accounts: result.accounts,
          chainId: CHAIN_ID,
        });
        this.saveConnections();
        this.sendToTab(tabId, 'accountsChanged', result.accounts);
        this.sendResponse(tabId, requestId, { success: true, data: { accounts: result.accounts } });
      } else {
        this.sendResponse(tabId, requestId, { success: false, error: ERRORS.USER_REJECTED });
      }
    } catch (error) {
      console.error('Request accounts error:', error);
      this.sendResponse(tabId, requestId, { success: false, error });
    }
  }

  async handleSendTransaction(payload, origin, tabId, requestId) {
    if (this.pendingRequest && this.pendingRequest.origin === origin) {
      console.log('Duplicate transaction request from same origin, rejecting');
      this.sendResponse(tabId, requestId, { success: false, error: ERRORS.USER_REJECTED });
      return;
    }
    const connection = this.connections.get(origin);
    if (!connection || connection.accounts.length === 0) {
      this.sendResponse(tabId, requestId, { success: false, error: ERRORS.UNAUTHORIZED });
      return;
    }

    try {
      const result = await this.requestApproval({
        requestId,
        action: 'sendTransaction',
        origin,
        tabId,
        to: payload.to,
        amount: payload.amount,
        from: connection.accounts[0],
      });

      if (result.txHash) {
        this.sendResponse(tabId, requestId, { success: true, data: { txHash: result.txHash } });
      } else {
        this.sendResponse(tabId, requestId, { success: false, error: ERRORS.USER_REJECTED });
      }
    } catch (error) {
      this.sendResponse(tabId, requestId, { success: false, error });
    }
  }

async handleOpenSendPage(payload, origin, tabId, requestId) {
    console.log('handleOpenSendPage called', { origin, tabId, payload });

    this.pendingApprovalParams = {
      action: 'sendTo',
      origin: origin,
      to: payload.to,
      tabId: tabId,
      requestId: requestId,
    };
    await browser.storage.local.set({ pendingApproval: JSON.stringify(this.pendingApprovalParams) });

    const popupUrl = 'index.html';
    this.focusOrCreatePopup(popupUrl)
      .then((win) => {
        if (tabId !== undefined) {
          browser.tabs.sendMessage(tabId, { type: 'WARTHOG_PROVIDER_RESPONSE', requestId, success: true, data: { pending: true } });
        }
      })
      .catch((error) => {
        console.error('Failed to open send page:', error);
      });
  }

  handleGetAccounts(origin, tabId, requestId) {
    const connection = this.connections.get(origin);
    const accounts = connection?.accounts || [];
    this.sendResponse(tabId, requestId, { success: true, data: { accounts } });
  }

  handleGetChainId(tabId, requestId) {
    this.sendResponse(tabId, requestId, { success: true, data: { chainId: CHAIN_ID } });
  }

  handleDisconnect(origin, tabId, requestId) {
    this.connections.delete(origin);
    this.saveConnections();
    this.sendResponse(tabId, requestId, { success: true, data: {} });
  }

  handleGetConnectionState(origin, tabId, requestId) {
    const connection = this.connections.get(origin);
    const accounts = connection?.accounts || [];
    this.sendResponse(tabId, requestId, { success: true, data: { accounts, connected: accounts.length > 0 } });
  }

  handleGetPendingApproval() {
    console.log('handleGetPendingApproval, pendingApprovalParams:', this.pendingApprovalParams);
    // Store in browser storage so popup can access it
    if (this.pendingApprovalParams) {
      browser.storage.local.set({ pendingApproval: JSON.stringify(this.pendingApprovalParams) });
    } else {
      browser.storage.local.remove('pendingApproval');
    }
    return this.pendingApprovalParams || null;
  }

  handleApproveRequest(payload) {
    console.log('handleApproveRequest called', payload);
    if (this.pendingRequest && this.pendingRequest.resolve) {
      const { accounts } = payload;
      if (this.pendingRequest.action === 'requestAccounts' && accounts) {
        this.pendingRequest.resolve({ accounts });
      } else if (payload.txHash) {
        this.pendingRequest.resolve({ txHash: payload.txHash });
      } else {
        this.pendingRequest.resolve({ accounts: [] });
      }
    }
    this.pendingRequest = null;
    this.pendingApprovalParams = null;
    browser.storage.local.remove('pendingApproval');
  }

  handleRejectRequest() {
    console.log('handleRejectRequest called');
    if (this.pendingRequest && this.pendingRequest.reject) {
      this.pendingRequest.reject(ERRORS.USER_REJECTED);
    }
    this.pendingRequest = null;
    this.pendingApprovalParams = null;
  }

  handleApprovalResult(payload) {
    console.log('handleApprovalResult called', payload);
    console.log('pendingRequest was', this.pendingRequest);
    if (!this.pendingRequest) return;

    const { approved, txHash, accounts } = payload;

    if (this.pendingRequest.resolve) {
      if (approved) {
        if (this.pendingRequest.action === 'requestAccounts' && accounts) {
          this.pendingRequest.resolve({ accounts });
        } else if (txHash) {
          this.pendingRequest.resolve({ txHash });
        } else {
          this.pendingRequest.resolve({ accounts: [] });
        }
      } else {
        this.pendingRequest.reject(ERRORS.USER_REJECTED);
      }
    }

    this.pendingRequest = null;
    if (this.approvalWindowId) {
      browser.windows.remove(this.approvalWindowId).catch(() => {});
      this.approvalWindowId = null;
    }
  }

requestApproval(data) {
    return new Promise((resolve, reject) => {
      const pendingRequest = {
        ...data,
        resolve,
        reject,
      };
      this.pendingRequest = pendingRequest;

      this.pendingApprovalParams = {
        action: data.action,
        origin: data.origin,
        to: data.to,
        amount: data.amount,
        from: data.from,
      };

      browser.storage.local.set({ pendingApproval: JSON.stringify(this.pendingApprovalParams) });

      const popupUrl = 'index.html';

      this.focusOrCreatePopup(popupUrl)
        .then((win) => {
          this.approvalWindowId = win?.id || null;
          // Opening the window is progress, not the result of the request.
          // The provider settles on its first response, so only the approval
          // handlers above send the final accounts, transaction hash, or error.
        })
        .catch((error) => {
          console.error('Failed to open approval window:', error);
          if (this.pendingRequest === pendingRequest) {
            this.pendingRequest = null;
            this.pendingApprovalParams = null;
            browser.storage.local.remove('pendingApproval');
          }
          reject(ERRORS.INTERNAL_ERROR);
        });
    });
  }

  sendToTab(tabId, action, data) {
    if (tabId === undefined) return;
    browser.tabs
      .sendMessage(tabId, { type: 'WARTHOG_PROVIDER_EVENT', action, data })
      .catch(() => {});
  }

  sendResponse(tabId, requestId, response) {
    console.log('sendResponse called', { tabId, requestId, response });
    if (tabId === undefined) {
      console.log('sendResponse: tabId is undefined, cannot send');
      return;
    }
    browser.tabs
      .sendMessage(tabId, { type: 'WARTHOG_PROVIDER_RESPONSE', requestId, success: response.success, data: response.data, error: response.error })
      .then(() => console.log('sendMessage sent successfully'))
      .catch((e) => console.error('sendMessage failed', e));
  }
}

new WarthogBackground();
