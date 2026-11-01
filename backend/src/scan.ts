import path from 'node:path';
import { q, SUDO_PASSWORD_RE, type Session } from './ssh';

/**
 * One `du` pass over a filesystem, kept in memory. Browsing folders afterwards reads
 * sizes from here instead of re-measuring the disk over SSH on every click.
 */
export type Scan = {
  root: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  dirs: number;
  current: string;
  denied: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  stale: boolean;
  sizes: Map<string, number>;
  children: Map<string, string[]>;
  cancel?: () => void;
};

export function scanSummary(s: Scan) {
  const { root, state, dirs, current, denied, startedAt, finishedAt, error, stale } = s;
  return { root, state, dirs, current, denied, startedAt, finishedAt, error, stale, total: s.sizes.get(root) ?? 0 };
}

export function startScan(session: Session, root: string, sudo: boolean): Scan {
  const existing = session.scans.get(root);
  if (existing?.state === 'running') return existing;

  const scan: Scan = {
    root, state: 'running', dirs: 0, current: root, denied: 0, startedAt: Date.now(), stale: false,
    sizes: new Map(), children: new Map(),
  };
  session.scans.set(root, scan);

  const cmd = `du -xk -- ${q(root)}`;
  session.conn.exec(sudo ? `sudo -n sh -c ${q(cmd)}` : cmd, (err, stream) => {
    if (err) {
      Object.assign(scan, { state: 'error', error: err.message, finishedAt: Date.now() });
      return;
    }
    scan.cancel = () => {
      scan.state = 'cancelled';
      stream.signal('KILL');
      stream.close();
    };
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (line: string) => {
      const tab = line.indexOf('\t');
      if (tab < 1) return;
      const p = line.slice(tab + 1);
      scan.sizes.set(p, Number(line.slice(0, tab)) * 1024);
      scan.dirs++;
      scan.current = p;
    };
    stream.on('data', (d: Buffer) => {
      buf += decoder.decode(d, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      lines.forEach(handle);
    });
    let stderr = '';
    stream.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      scan.denied += text.match(/denied/gi)?.length ?? 0;
      if (stderr.length < 4000) stderr += text;
    });
    stream.on('close', () => {
      handle(buf);
      scan.finishedAt = Date.now();
      if (scan.state === 'cancelled') return;
      if (SUDO_PASSWORD_RE.test(stderr)) {
        Object.assign(scan, { state: 'error', error: 'sudo needs a password on this VM. Turn off "Use sudo".' });
        return;
      }
      if (!scan.sizes.has(root)) {
        Object.assign(scan, { state: 'error', error: stderr.trim().split('\n')[0] || 'Scan produced no results' });
        return;
      }
      buildChildren(scan);
      scan.state = 'done';
    });
  });
  return scan;
}

function buildChildren(scan: Scan) {
  for (const p of scan.sizes.keys()) {
    if (p === scan.root) continue;
    const parent = path.posix.dirname(p);
    const list = scan.children.get(parent);
    if (list) list.push(p);
    else scan.children.set(parent, [p]);
  }
  for (const list of scan.children.values()) list.sort((a, b) => scan.sizes.get(b)! - scan.sizes.get(a)!);
}

const within = (root: string, p: string) => root === '/' || p === root || p.startsWith(root + '/');

/** The finished scan that knows this folder, preferring the most specific mount. */
export function findIndex(session: Session, dir: string): Scan | undefined {
  let best: Scan | undefined;
  for (const s of session.scans.values()) {
    if (s.state !== 'done' || !within(s.root, dir) || !s.sizes.has(dir)) continue;
    if (!best || s.root.length > best.root.length) best = s;
  }
  return best;
}

export function indexedDirs(session: Session, scan: Scan, dir: string) {
  return (scan.children.get(dir) ?? []).map((p) => {
    const mounted = p !== scan.root && session.mounts.includes(p);
    const own = mounted ? session.scans.get(p) : undefined;
    const size = own?.state === 'done' ? own.sizes.get(p) ?? 0 : scan.sizes.get(p)!;
    return {
      name: path.posix.basename(p),
      path: p,
      size,
      mount: mounted,
      hasChildren: mounted ? true : (scan.children.get(p)?.length ?? 0) > 0,
    };
  });
}

/** Keep the index truthful after a delete / empty without rescanning. */
export function forgetBytes(session: Session, target: string, bytes: number, removed: boolean) {
  for (const scan of session.scans.values()) {
    if (scan.state !== 'done' || !within(scan.root, target) || target === scan.root) continue;
    if (removed && scan.sizes.has(target)) {
      const prefix = target + '/';
      for (const p of [...scan.sizes.keys()]) {
        if (p === target || p.startsWith(prefix)) {
          scan.sizes.delete(p);
          scan.children.delete(p);
        }
      }
      const parentList = scan.children.get(path.posix.dirname(target));
      const i = parentList?.indexOf(target) ?? -1;
      if (i >= 0) parentList!.splice(i, 1);
    }
    let cur = target;
    while (cur !== scan.root) {
      cur = path.posix.dirname(cur);
      const size = scan.sizes.get(cur);
      if (size !== undefined) scan.sizes.set(cur, Math.max(0, size - bytes));
    }
  }
}
