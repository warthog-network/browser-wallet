import browser from 'webextension-polyfill';

export interface PendingApproval {
  approvalId: string;
  action: string;
  origin: string;
  to?: string;
  amount?: string;
  from?: string;
}

export async function getPendingApproval(): Promise<PendingApproval | null> {
  try {
    const result = await browser.storage.local.get('pendingApproval');
    if (result.pendingApproval) {
      return JSON.parse(result.pendingApproval as string);
    }
    return null;
  } catch (error) {
    console.error('Error getting pending approval:', error);
    return null;
  }
}

export async function approveRequest(approvalId: string, accounts?: string[], txHash?: string): Promise<boolean> {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'approveRequest',
      payload: { approvalId, accounts, txHash },
    }) as { success?: boolean };
    return response?.success === true;
  } catch (error) {
    console.error('Error approving request:', error);
    return false;
  }
}

export async function rejectRequest(approvalId: string): Promise<boolean> {
  try {
    const response = await browser.runtime.sendMessage({ action: 'rejectRequest', payload: { approvalId } }) as { success?: boolean };
    return response?.success === true;
  } catch (error) {
    console.error('Error rejecting request:', error);
    return false;
  }
}

export async function deferApproval(approvalId: string): Promise<boolean> {
  try {
    const response = await browser.runtime.sendMessage({ action: 'deferApproval', payload: { approvalId } }) as { success?: boolean };
    return response?.success === true;
  } catch (error) {
    console.error('Error deferring request:', error);
    return false;
  }
}
