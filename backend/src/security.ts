import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from './ssh';

const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const COOKIE = 'vmsm_auth';

/** A per-machine secret, kept in ~/.config/vm-storage/token (readable only by you). */
export async function loadToken(): Promise<string> {
  const existing = (await readFile(TOKEN_FILE, 'utf8').catch(() => '')).trim();
  if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  const token = randomBytes(32).toString('hex');
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, token + '\n', { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600);
  return token;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * - Host check blocks DNS-rebinding attacks from other websites.
 * - Origin check blocks other websites from calling the API from your browser.
 * - The token cookie (set from the one-time link printed at startup) blocks other programs and users on this Mac.
 * - A custom header on writes forces a CORS preflight, which this server never approves.
 */
export function security(token: string, allowedHosts: string[]): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!allowedHosts.includes(host)) return c.text('Forbidden host', 403);
    const origin = c.req.header('origin');
    if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return c.text('Forbidden origin', 403);

    const url = new URL(c.req.url);
    const linkToken = url.searchParams.get('token');
    if (linkToken !== null) {
      if (same(linkToken, token)) {
        setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 30 * 24 * 3600 });
      }
      return c.redirect('/');
    }

    if (url.pathname.startsWith('/api/')) {
      if (!same(getCookie(c, COOKIE) ?? '', token)) return c.json({ error: 'locked', code: 'locked' }, 401);
      if (c.req.method !== 'GET' && c.req.header('x-vmsm') !== '1') return c.json({ error: 'Missing request header' }, 403);
    }
    await next();
  };
}
