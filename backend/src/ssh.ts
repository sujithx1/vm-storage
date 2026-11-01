import { Client, type ConnectConfig } from 'ssh2';
import { HTTPException } from 'hono/http-exception';
import { createHash, createHmac } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Scan } from './scan';

export const CONFIG_DIR = path.join(homedir(), '.config', 'vm-storage');
const APP_KNOWN_HOSTS = path.join(CONFIG_DIR, 'known_hosts');
const USER_KNOWN_HOSTS = path.join(homedir(), '.ssh', 'known_hosts');
const IDLE_LIMIT_MS = 30 * 60_000;

export type Session = {
  id: string;
  conn: Client;
  label: string;
  isRoot: boolean;
  /** Only held in memory for this connection, only ever written to sudo's stdin. */
  sudoPassword?: string;
  lastUsed: number;
  mounts: string[];
  scans: Map<string, Scan>;
};

export const sessions = new Map<string, Session>();

// Drop SSH sessions nobody has used for a while so credentials don't stay live forever.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUsed > IDLE_LIMIT_MS) s.conn.end();
}, 60_000).unref();

export const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 504;
export const fail = (status: Status, message: string) => new HTTPException(status, { message });

export function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/')) throw fail(400, 'Path must be absolute');
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

export type ExecResult = { code: number; stdout: string; stderr: string };

export function exec(conn: Client, cmd: string, { stdin, timeoutMs = 10 * 60_000 }: { stdin?: string; timeoutMs?: number } = {}) {
  return new Promise<ExecResult>((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(fail(504, 'Command timed out'));
      }, timeoutMs);
      stream.on('data', (d: Buffer) => (stdout += d));
      stream.stderr.on('data', (d: Buffer) => (stderr += d));
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (stdin !== undefined) stream.end(stdin);
    });
  });
}

/**
 * Run as root when asked. With a sudo password, it goes to sudo's stdin (`-S`) ahead of any
 * other input, so it never shows up in the remote process list or shell history.
 */
export function wrapSudo(s: Session, cmd: string, sudo: boolean) {
  if (!sudo || s.isRoot) return { cmd, stdinPrefix: '' };
  if (s.sudoPassword) return { cmd: `sudo -S -p '' sh -c ${q(cmd)}`, stdinPrefix: s.sudoPassword + '\n' };
  return { cmd: `sudo -n sh -c ${q(cmd)}`, stdinPrefix: '' };
}

export function run(s: Session, cmd: string, { sudo = false, stdin, timeoutMs }: { sudo?: boolean; stdin?: string; timeoutMs?: number } = {}) {
  const w = wrapSudo(s, cmd, sudo);
  const input = w.stdinPrefix || stdin !== undefined ? w.stdinPrefix + (stdin ?? '') : undefined;
  return exec(s.conn, w.cmd, { stdin: input, timeoutMs });
}

export const SUDO_PASSWORD_RE = /sudo: a (terminal|password) is required/;
export const SUDO_WRONG_RE = /Sorry, try again|incorrect password attempt/;

export function sudoProblem(stderr: string): string | undefined {
  if (SUDO_PASSWORD_RE.test(stderr)) return 'sudo needs your password on this VM. Click “Use sudo” to enter it.';
  if (SUDO_WRONG_RE.test(stderr)) return 'The sudo password was rejected. Click “Use sudo” to enter it again.';
}

export function checkSudo(stderr: string) {
  const problem = sudoProblem(stderr);
  if (problem) throw fail(403, problem);
}

export function getSession(id: string | undefined): Session {
  const s = sessions.get(id ?? '');
  if (!s) throw fail(401, 'Not connected (the SSH session may have dropped). Please reconnect.');
  s.lastUsed = Date.now();
  return s;
}

/* ---------- Host key verification ---------- */

export class HostKeyError extends Error {
  constructor(
    public code: 'unknown_host' | 'host_key_changed' | 'host_key_revoked',
    public fingerprint: string,
    public keyType: string,
    public knownHostsFile?: string,
  ) {
    super(code);
  }
}

type KnownKey = { type: string; key: string; revoked: boolean; file: string };

const fingerprint = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const keyType = (blob: Buffer) => blob.subarray(4, 4 + blob.readUInt32BE(0)).toString();
const hostName = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`);

function hostMatches(field: string, name: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
  }
  let matched = false;
  for (const pattern of field.split(',')) {
    const negate = pattern.startsWith('!');
    const glob = negate ? pattern.slice(1) : pattern;
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    if (re.test(name)) {
      if (negate) return false;
      matched = true;
    }
  }
  return matched;
}

async function knownKeys(host: string, port: number): Promise<KnownKey[]> {
  const name = hostName(host, port);
  const out: KnownKey[] = [];
  for (const file of [USER_KNOWN_HOSTS, APP_KNOWN_HOSTS]) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      let revoked = false;
      if (parts[0].startsWith('@')) {
        if (parts[0] === '@revoked') revoked = true;
        else continue; // @cert-authority entries are not supported
        parts.shift();
      }
      const [hosts, type, key] = parts;
      if (hosts && type && key && hostMatches(hosts, name)) out.push({ type, key, revoked, file });
    }
  }
  return out;
}

async function rememberHost(host: string, port: number, blob: Buffer) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await appendFile(APP_KNOWN_HOSTS, `${hostName(host, port)} ${keyType(blob)} ${blob.toString('base64')}\n`, { mode: 0o600 });
  await chmod(APP_KNOWN_HOSTS, 0o600);
}

/* ---------- Connect ---------- */

export type ConnectInput = {
  host: string;
  port?: number | string;
  username: string;
  password?: string;
  keyPath?: string;
  privateKey?: string;
  passphrase?: string;
  trustFingerprint?: string;
};

export async function connect(input: ConnectInput): Promise<Client> {
  const { host, username, password, keyPath, privateKey, passphrase, trustFingerprint } = input;
  const port = Number(input.port) || 22;
  if (!host || !username) throw fail(400, 'Host and username are required');

  const known = await knownKeys(host, port);
  let hostKeyProblem: HostKeyError | undefined;
  let newHostKey: Buffer | undefined;

  const cfg: ConnectConfig = {
    host, port, username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    hostVerifier: (blob: Buffer) => {
      const b64 = blob.toString('base64');
      const type = keyType(blob);
      const fp = fingerprint(blob);
      const match = known.find((k) => k.key === b64);
      if (match?.revoked) { hostKeyProblem = new HostKeyError('host_key_revoked', fp, type, match.file); return false; }
      if (match) return true;
      const sameType = known.find((k) => k.type === type && !k.revoked);
      if (sameType) { hostKeyProblem = new HostKeyError('host_key_changed', fp, type, sameType.file); return false; }
      if (trustFingerprint === fp) { newHostKey = blob; return true; }
      hostKeyProblem = new HostKeyError('unknown_host', fp, type);
      return false;
    },
  };
  if (privateKey?.trim()) cfg.privateKey = privateKey;
  else if (keyPath?.trim()) {
    const p = keyPath.trim().replace(/^~(?=\/|$)/, homedir());
    const file = Bun.file(p);
    if (!(await file.exists())) throw fail(400, `Cannot read key file: ${p}`);
    cfg.privateKey = Buffer.from(await file.arrayBuffer());
  }
  if (cfg.privateKey && passphrase) cfg.passphrase = passphrase;
  if (password) cfg.password = password;
  if (!cfg.privateKey && !password && process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;

  const conn = new Client();
  await new Promise<void>((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', (e) => reject(hostKeyProblem ?? fail(400, `SSH connection failed: ${e.message}`)));
    try { conn.connect(cfg); } catch (e) { reject(fail(400, (e as Error).message)); }
  });
  if (newHostKey) await rememberHost(host, port, newHostKey);
  return conn;
}

/* ---------- ~/.ssh/config ---------- */

export type SshHost = { alias: string; host: string; user?: string; port?: number; keyPath?: string };

export async function sshConfigHosts(): Promise<SshHost[]> {
  const text = await readFile(path.join(homedir(), '.ssh', 'config'), 'utf8').catch(() => '');
  const hosts: SshHost[] = [];
  let current: SshHost[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*(?:=|\s)\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias, host: alias }));
      hosts.push(...current);
    } else if (key === 'match') {
      current = [];
    } else {
      for (const h of current) {
        if (key === 'hostname' && h.host === h.alias) h.host = value;
        if (key === 'user' && !h.user) h.user = value;
        if (key === 'port' && !h.port) h.port = Number(value);
        if (key === 'identityfile' && !h.keyPath) h.keyPath = value;
      }
    }
  }
  return hosts;
}
