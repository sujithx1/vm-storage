import { useEffect, useState, type FormEvent } from 'react';
import { HardDrive, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../api';
import type { SessionInfo, SshHost } from '../types';
import { Modal, Spinner } from '../ui';

type Auth = 'agent' | 'keyPath' | 'privateKey' | 'password';
type Recent = { host: string; port: string; username: string; auth: Auth; keyPath: string };
type HostKeyIssue = { code: string; fingerprint: string; keyType: string; knownHostsFile?: string };

const RECENT_KEY = 'vmsm.recent';
const loadRecent = (): Recent[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };

const AUTH_TABS: { id: Auth; label: string }[] = [
  { id: 'keyPath', label: 'Key file' },
  { id: 'agent', label: 'ssh-agent' },
  { id: 'privateKey', label: 'Paste key' },
  { id: 'password', label: 'Password' },
];

export function ConnectScreen({ message, onConnected }: { message?: string; onConnected: (info: SessionInfo) => void }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<Auth>('keyPath');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');
  const [privateKey, setPrivateKey] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(message ?? '');
  const [hostKey, setHostKey] = useState<HostKeyIssue | null>(null);
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);

  useEffect(() => { api.sshHosts().then((r) => setSshHosts(r.hosts)).catch(() => {}); }, []);

  const fill = (h: { host: string; port?: string | number; username?: string; keyPath?: string; auth?: Auth }) => {
    setHost(h.host);
    setPort(String(h.port ?? 22));
    if (h.username) setUsername(h.username);
    if (h.keyPath) { setKeyPath(h.keyPath); setAuth('keyPath'); }
    else if (h.auth) setAuth(h.auth);
    setError('');
  };

  const submit = async (e?: FormEvent, trustFingerprint?: string) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { host: host.trim(), port: port.trim() || 22, username: username.trim(), trustFingerprint };
    if (auth === 'password') body.password = password;
    if (auth === 'keyPath') Object.assign(body, { keyPath, passphrase });
    if (auth === 'privateKey') Object.assign(body, { privateKey, passphrase });
    try {
      const info = await api.connect(body);
      // Remember where we connected, never the password, passphrase or key contents.
      const entry: Recent = { host: host.trim(), port: port.trim() || '22', username: username.trim(), auth, keyPath: auth === 'keyPath' ? keyPath : '' };
      const list = [entry, ...recent.filter((r) => !(r.host === entry.host && r.port === entry.port && r.username === entry.username))].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
      setRecent(list);
      setPassword(''); setPassphrase(''); setPrivateKey('');
      onConnected(info);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setHostKey(err.data as HostKeyIssue);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <div className="card">
        <div className="brand"><HardDrive size={22} /> <h1>VM Storage Manager</h1></div>
        <p className="muted">Connect to a VM over SSH to see where disk space goes and clean it up.</p>

        {(sshHosts.length > 0 || recent.length > 0) && (
          <div className="quick">
            {sshHosts.map((h) => (
              <button key={'c' + h.alias} type="button" className="chip" title={`From ~/.ssh/config: ${h.user ?? ''}@${h.host}`}
                onClick={() => fill({ host: h.host, port: h.port, username: h.user, keyPath: h.keyPath, auth: 'agent' })}>
                {h.alias}
              </button>
            ))}
            {recent.map((r) => (
              <button key={'r' + r.username + r.host + r.port} type="button" className="chip ghost" onClick={() => fill(r)}>
                {r.username}@{r.host}{r.port !== '22' ? `:${r.port}` : ''}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="row">
            <label className="field grow"><span>Host / IP</span><input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="203.0.113.10" /></label>
            <label className="field port"><span>Port</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></label>
          </div>
          <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} required placeholder="ubuntu" /></label>

          <div className="segmented">
            {AUTH_TABS.map((t) => (
              <button key={t.id} type="button" className={auth === t.id ? 'active' : ''} onClick={() => setAuth(t.id)}>{t.label}</button>
            ))}
          </div>

          {auth === 'keyPath' && (
            <label className="field"><span>Private key on this Mac</span><input className="mono" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} /></label>
          )}
          {auth === 'privateKey' && (
            <label className="field"><span>Private key</span>
              <textarea className="mono" rows={5} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            </label>
          )}
          {(auth === 'keyPath' || auth === 'privateKey') && (
            <label className="field"><span>Key passphrase (if it has one)</span><input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
          )}
          {auth === 'password' && (
            <>
              <label className="field"><span>Password</span><input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <p className="hint"><KeyRound size={13} /> SSH keys are safer than passwords. The password is only sent to the VM and is never saved.</p>
            </>
          )}
          {auth === 'agent' && <p className="hint"><KeyRound size={13} /> Uses the keys already loaded in your ssh-agent (ssh-add -l).</p>}

          <button className="primary block" disabled={busy}>{busy ? <><Spinner /> Connecting…</> : 'Connect'}</button>
          {error && <div className="error-box">{error}</div>}
        </form>
      </div>

      {hostKey && <HostKeyDialog issue={hostKey} host={host} onClose={() => setHostKey(null)}
        onTrust={() => { setHostKey(null); submit(undefined, hostKey.fingerprint); }} />}
    </div>
  );
}

function HostKeyDialog({ issue, host, onClose, onTrust }: { issue: HostKeyIssue; host: string; onClose: () => void; onTrust: () => void }) {
  if (issue.code === 'unknown_host') {
    return (
      <Modal title={<><ShieldCheck size={18} /> First connection to {host}</>} onClose={onClose}
        footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={onTrust}>Trust and connect</button></>}>
        <p>This VM is not in your known hosts yet. Check that its fingerprint matches the one your cloud console or the VM shows:</p>
        <div className="fingerprint mono">{issue.keyType}<br />{issue.fingerprint}</div>
        <p className="muted small">On the VM you can print it with: <span className="mono">for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done</span></p>
      </Modal>
    );
  }
  return (
    <Modal title={<><ShieldAlert size={18} /> Host key {issue.code === 'host_key_revoked' ? 'revoked' : 'changed'}!</>} onClose={onClose}
      footer={<button onClick={onClose}>Close</button>}>
      <div className="danger-box">
        The VM answered with a different identity than last time. Someone could be intercepting the connection,
        so nothing was sent and no password was used.
      </div>
      <p>New fingerprint: <span className="mono">{issue.fingerprint}</span></p>
      <p className="muted small">
        If you rebuilt or replaced this VM on purpose, remove its old entry from <span className="mono">{issue.knownHostsFile}</span>
        {' '}(for example with <span className="mono">ssh-keygen -R {host} -f {issue.knownHostsFile}</span>) and connect again.
      </p>
    </Modal>
  );
}
