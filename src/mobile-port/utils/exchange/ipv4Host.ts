import browser from 'webextension-polyfill';
import { ExchangeError, explainBody, explainForwarderFailure } from './http';

const HOST = 'com.warthog.safetrade';

type HostResponse = {
  status?: number;
  body?: string;
  error?: string;
};

/**
 * Signed SafeTrade calls cannot use the browser stack. It prefers IPv6 for
 * safe.trade, and SafeTrade cannot store an IPv6 allowlist entry. The native
 * host repeats the call with curl -4.
 */
export async function requestSafeTradeIpv4(
  pathAndQuery: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<unknown> {
  const splitAt = pathAndQuery.indexOf('?');
  const path = splitAt === -1 ? pathAndQuery : pathAndQuery.slice(0, splitAt);
  const search = splitAt === -1 ? '' : pathAndQuery.slice(splitAt);
  let response: HostResponse | undefined;
  try {
    response = await browser.runtime.sendNativeMessage(HOST, {
      method,
      path,
      search,
      headers,
      body: body ?? null,
    }) as HostResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The SafeTrade IPv4 forwarder failed.';
    throw new ExchangeError(message, 0, null);
  }
  if (!response || typeof response !== 'object') {
    throw new ExchangeError('The SafeTrade IPv4 forwarder failed.', 0, null);
  }
  if (response.error) {
    throw new ExchangeError(response.error, 0, null);
  }
  const status = Number(response.status ?? 0);
  const text = typeof response.body === 'string' ? response.body : '';
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (status < 200 || status >= 300) {
    throw new ExchangeError(explainBody(parsed, status), status || 0, parsed);
  }
  return parsed;
}

export type ForwarderProbe = {
  state: 'connected' | 'forbidden' | 'missing' | 'failed' | 'unavailable';
  detail: string;
  /** The sentence Brave returned, when it differs from detail. */
  browserMessage: string;
  extensionId: string;
};

function probeState(message: string): ForwarderProbe['state'] {
  if (/forbidden|disabled by the system/i.test(message)) return 'forbidden';
  if (/not found|can.?t find|cannot find|not the binary/i.test(message)) return 'missing';
  return 'failed';
}

/** Ask Brave to start the host. A ping does not call SafeTrade. */
export async function probeSafeTradeForwarder(): Promise<ForwarderProbe> {
  const extensionId = typeof browser.runtime?.id === 'string' ? browser.runtime.id : '';
  if (!browser.runtime?.sendNativeMessage) {
    return {
      state: 'unavailable',
      detail: 'Open SafeTrade from the extension. This page cannot start the forwarder.',
      browserMessage: '',
      extensionId,
    };
  }
  try {
    const response = await browser.runtime.sendNativeMessage(HOST, { op: 'ping' }) as HostResponse & { ok?: boolean };
    if (response && typeof response === 'object' && response.ok) {
      return {
        state: 'connected',
        detail: 'Brave can start the forwarder. Signed calls leave over IPv4.',
        browserMessage: '',
        extensionId,
      };
    }
    if (response && typeof response === 'object') {
      return {
        state: 'connected',
        detail: 'Brave started the forwarder. Signed calls can leave over IPv4.',
        browserMessage: '',
        extensionId,
      };
    }
    return {
      state: 'failed',
      detail: 'The forwarder answered with nothing.',
      browserMessage: '',
      extensionId,
    };
  } catch (err) {
    const browserMessage = err instanceof Error ? err.message : 'The forwarder did not start.';
    return {
      state: probeState(browserMessage),
      detail: explainForwarderFailure(browserMessage),
      browserMessage,
      extensionId,
    };
  }
}
