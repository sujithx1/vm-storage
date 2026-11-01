export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 1024) return `${Math.max(0, Math.round(b || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < units.length - 1);
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${units[i]}`;
}

export const fmtNum = (n: number) => n.toLocaleString();

export function fmtAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const parentOf = (p: string) => (p === '/' ? '/' : p.replace(/\/[^/]+$/, '') || '/');

export const pctClass = (pct: number) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '');
