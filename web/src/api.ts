import type { CleanResult, CleanupTarget, Contents, Disk, LargeFile, ScanStatus, SessionInfo, SshHost, TreeNode } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, any> = {}) {
    super(message);
  }
}

let sessionId = sessionStorage.getItem('vmsm.session') ?? '';
export function setSessionId(id: string) {
  sessionId = id;
  if (id) sessionStorage.setItem('vmsm.session', id);
  else sessionStorage.removeItem('vmsm.session');
}

type Listener = (reason: 'locked' | 'disconnected') => void;
let onAuthLost: Listener = () => {};
export const setAuthLostListener = (fn: Listener) => { onAuthLost = fn; };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-vmsm': '1', 'x-session': sessionId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) onAuthLost(data.code === 'locked' ? 'locked' : 'disconnected');
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data);
  return data as T;
}

const qs = (params: Record<string, string | number | boolean>) =>
  '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)])).toString();

export const api = {
  sshHosts: () => call<{ hosts: SshHost[] }>('GET', '/api/ssh-hosts'),
  session: () => call<{ id: string; label: string }>('GET', '/api/session'),
  connect: (body: Record<string, unknown>) => call<SessionInfo>('POST', '/api/connect', body),
  disconnect: () => call('POST', '/api/disconnect'),
  disks: () => call<{ disks: Disk[] }>('GET', '/api/disks'),
  scans: () => call<{ scans: ScanStatus[] }>('GET', '/api/scans'),
  startScan: (path: string, sudo: boolean) => call<ScanStatus>('POST', '/api/scan', { path, sudo }),
  cancelScan: (path: string) => call('POST', '/api/scan/cancel', { path }),
  tree: (path: string) => call<{ path: string; size: number; children: TreeNode[] }>('GET', '/api/tree' + qs({ path })),
  contents: (path: string, sudo: boolean) => call<Contents>('GET', '/api/contents' + qs({ path, sudo })),
  largest: (path: string, minMb: number, sudo: boolean) => call<{ files: LargeFile[] }>('GET', '/api/largest' + qs({ path, minMb, sudo })),
  readFile: (path: string, sudo: boolean) => call<{ content: string }>('GET', '/api/file' + qs({ path, sudo })),
  writeFile: (path: string, content: string, sudo: boolean) => call('PUT', '/api/file', { path, content, sudo }),
  remove: (path: string, sudo: boolean) => call<{ freed: number }>('POST', '/api/delete', { path, sudo }),
  truncate: (path: string, sudo: boolean) => call<{ freed: number }>('POST', '/api/truncate', { path, sudo }),
  cleanupTargets: (sudo: boolean) => call<{ targets: CleanupTarget[] }>('GET', '/api/cleanup' + qs({ sudo })),
  runCleanup: (ids: string[], sudo: boolean, force: boolean) => call<{ results: CleanResult[] }>('POST', '/api/cleanup', { ids, sudo, force }),
};
