import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from 'hono/bun';
import path from 'node:path';
import { cleanPath, connect, fail, getSession, HostKeyError, sessions, sshConfigHosts, exec, type ConnectInput } from './ssh';
import { loadToken, security } from './security';
import { findIndex, indexedDirs, scanSummary, startScan } from './scan';
import * as files from './files';
import * as cleanup from './cleanup';

const PORT = Number(process.env.PORT) || 4848;
const DEV = !!process.env.VMSM_DEV;
// The UI is a separate project; serve its production build if it has been built.
const DIST = process.env.FRONTEND_DIST ?? path.join(import.meta.dir, '..', '..', 'frontend', 'dist');

const token = await loadToken();
const allowedHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
if (DEV) allowedHosts.push('localhost:5173', '127.0.0.1:5173');

const app = new Hono();

app.use(secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: 'no-referrer',
}));
app.use(security(token, allowedHosts));

app.onError((err, c) => {
  if (err instanceof HostKeyError) {
    return c.json({ error: err.code, code: err.code, fingerprint: err.fingerprint, keyType: err.keyType, knownHostsFile: err.knownHostsFile }, 409);
  }
  const status = err instanceof HTTPException ? err.status : 500;
  return c.json({ error: err.message || String(err) }, status);
});

const session = (c: Context) => getSession(c.req.header('x-session'));
const sudoParam = (c: Context) => c.req.query('sudo') === '1';

/* ---------- Connection ---------- */

app.get('/api/ssh-hosts', async (c) => c.json({ hosts: await sshConfigHosts() }));

app.post('/api/connect', async (c) => {
  const input = await c.req.json<ConnectInput>();
  const conn = await connect(input);
  const id = crypto.randomUUID();
  const label = `${input.username}@${input.host}`;
  const { stdout } = await exec(conn, [
    'uname -sr', 'hostname', 'id -u',
    'if sudo -n true 2>/dev/null; then echo nopasswd; elif id -nG | grep -qwE "sudo|wheel|admin"; then echo password; else echo none; fi',
  ].join('; '));
  const [os, hostname, uid, sudoState] = stdout.trim().split('\n');
  const isRoot = uid === '0';
  sessions.set(id, { id, conn, label, isRoot, lastUsed: Date.now(), mounts: [], scans: new Map() });
  conn.on('close', () => {
    const s = sessions.get(id);
    s?.scans.forEach((scan) => scan.state === 'running' && scan.cancel?.());
    sessions.delete(id);
  });
  // root: everything is readable already; nopasswd: sudo just works; password: ask for it in the UI.
  return c.json({ id, label, os, hostname, sudoMode: isRoot ? 'root' : sudoState });
});

/** Check the sudo password once, then keep it in memory for this connection only. */
app.post('/api/sudo', async (c) => {
  const s = session(c);
  const { password } = await c.req.json();
  if (typeof password !== 'string' || !password || password.length > 1024) throw fail(400, 'Enter your sudo password');
  // -k ignores any cached sudo session so the password is really checked.
  const { code } = await exec(s.conn, `sudo -S -k -p '' true`, { stdin: password + '\n', timeoutMs: 20_000 });
  if (code !== 0) throw fail(403, 'Wrong sudo password, or this user is not allowed to use sudo.');
  s.sudoPassword = password;
  return c.json({ ok: true });
});

app.get('/api/session', (c) => {
  const s = session(c);
  return c.json({ id: s.id, label: s.label, sudoUnlocked: !!s.sudoPassword });
});

app.post('/api/disconnect', (c) => {
  sessions.get(c.req.header('x-session') ?? '')?.conn.end();
  return c.json({ ok: true });
});

/* ---------- Disks and scanning ---------- */

app.get('/api/disks', async (c) => c.json({ disks: await files.disks(session(c)) }));

app.post('/api/scan', async (c) => {
  const s = session(c);
  const { path: p, sudo } = await c.req.json();
  return c.json(scanSummary(startScan(s, cleanPath(p), !!sudo)));
});

app.post('/api/scan/cancel', async (c) => {
  const s = session(c);
  const { path: p } = await c.req.json();
  s.scans.get(cleanPath(p))?.cancel?.();
  return c.json({ ok: true });
});

app.get('/api/scans', (c) => c.json({ scans: [...session(c).scans.values()].map(scanSummary) }));

/** Child folders with sizes, straight from the in-memory index: no SSH round trip. */
app.get('/api/tree', (c) => {
  const s = session(c);
  const dir = cleanPath(c.req.query('path'));
  const index = findIndex(s, dir);
  if (!index) throw fail(404, 'This folder has not been scanned yet');
  return c.json({ path: dir, size: index.sizes.get(dir), children: indexedDirs(s, index, dir) });
});

/* ---------- Files ---------- */

app.get('/api/contents', async (c) => c.json(await files.contents(session(c), cleanPath(c.req.query('path')), sudoParam(c))));

app.get('/api/largest', async (c) => {
  const minMb = Math.max(1, Math.floor(Number(c.req.query('minMb')) || 50));
  return c.json({ files: await files.largest(session(c), cleanPath(c.req.query('path')), minMb, sudoParam(c)) });
});

app.get('/api/file', async (c) => {
  const p = cleanPath(c.req.query('path'));
  return c.json({ path: p, content: await files.readText(session(c), p, sudoParam(c)) });
});

app.put('/api/file', async (c) => {
  const s = session(c);
  const { path: p, content, sudo } = await c.req.json();
  if (typeof content !== 'string') throw fail(400, 'Missing content');
  await files.writeText(s, cleanPath(p), content, !!sudo);
  return c.json({ ok: true });
});

app.post('/api/delete', async (c) => {
  const s = session(c);
  const { path: p, sudo } = await c.req.json();
  return c.json({ freed: await files.remove(s, cleanPath(p), !!sudo) });
});

app.post('/api/truncate', async (c) => {
  const s = session(c);
  const { path: p, sudo } = await c.req.json();
  return c.json({ freed: await files.truncate(s, cleanPath(p), !!sudo) });
});

/* ---------- Cleanup ---------- */

app.get('/api/cleanup', async (c) => c.json({ targets: await cleanup.detect(session(c), sudoParam(c)) }));

app.post('/api/cleanup', async (c) => {
  const s = session(c);
  const { ids, sudo, force } = await c.req.json();
  if (!Array.isArray(ids)) throw fail(400, 'ids must be a list');
  return c.json({ results: await cleanup.clean(s, ids.map(String), !!sudo, force === true) });
});

/* ---------- UI ---------- */

app.use('/*', serveStatic({ root: path.relative(process.cwd(), DIST) || '.' }));
app.get('/', (c) => c.text('UI not built yet. Run "bun run build" in the frontend folder first.', 503));

try {
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    // Long SSH commands (big deletes, cleanups) can take minutes; Bun's default 10s idle timeout would cut them off.
    idleTimeout: 0,
    fetch: app.fetch,
  });
} catch (e) {
  if ((e as { code?: string }).code !== 'EADDRINUSE') throw e;
  console.error(`\nPort ${PORT} is already in use (probably another copy of this app).`);
  console.error(`Stop it, or see what is using it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  console.error(`Or run on another port:                 PORT=${PORT + 1} bun start\n`);
  process.exit(1);
}

const url = `http://localhost:${PORT}/?token=${token}`;
console.log(`\nVM Storage Manager is running.\nOpen this link (it signs this browser in):\n\n  ${url}\n`);
if (!process.env.NO_OPEN && process.platform === 'darwin') Bun.spawn(['open', url]);
