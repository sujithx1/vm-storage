import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent } from 'react';
import { FolderTree as TreeIcon, LockKeyhole, LogOut, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { Disk, ScanStatus, SessionInfo } from '../types';
import { Modal, Spinner, useToast } from '../ui';
import { DiskBar } from './DiskBar';
import { Explorer } from './Explorer';
import { Cleanup } from './Cleanup';

type Ws = {
  info: SessionInfo;
  /** Commands run as root (sudo on, or connected as root). */
  sudo: boolean;
  /** This user can become root at all (possibly after entering the sudo password). */
  sudoAvailable: boolean;
  /** Turn sudo on, asking for the password first if the VM needs one. */
  requestSudo: () => void;
  disks: Disk[];
  scans: Map<string, ScanStatus>;
  /** Bumped whenever sizes change, so trees and panels refetch. */
  version: number;
  refresh: () => void;
  startScan: (root: string) => Promise<void>;
  cancelScan: (root: string) => Promise<void>;
};

const WsCtx = createContext<Ws>(null!);
export const useWs = () => useContext(WsCtx);

export function Workspace({ info, onDisconnect }: { info: SessionInfo; onDisconnect: () => void }) {
  const toast = useToast();
  const isRoot = info.sudoMode === 'root';
  const [sudo, setSudo] = useState(isRoot || info.sudoMode === 'nopasswd');
  const [unlocked, setUnlocked] = useState(info.sudoMode !== 'password');
  const [askPassword, setAskPassword] = useState(false);
  const [disks, setDisks] = useState<Disk[]>([]);
  const [scans, setScans] = useState<Map<string, ScanStatus>>(new Map());
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<'explore' | 'cleanup'>('explore');
  const [mount, setMount] = useState('/');

  const loadDisks = useCallback(() => api.disks().then((r) => {
    setDisks(r.disks);
    setMount((m) => r.disks.some((d) => d.mount === m) ? m : r.disks[0]?.mount ?? '/');
  }).catch((e) => toast(e.message, true)), [toast]);

  const loadScans = useCallback(async () => {
    const r = await api.scans();
    setScans(new Map(r.scans.map((s) => [s.root, s])));
    return r.scans;
  }, []);

  useEffect(() => { loadDisks(); loadScans().catch(() => {}); }, [loadDisks, loadScans]);

  // After a page reload the server may still hold the sudo password for this connection.
  useEffect(() => {
    if (info.sudoMode !== 'password') return;
    api.session().then((r) => { if (r.sudoUnlocked) { setUnlocked(true); setSudo(true); } }).catch(() => {});
  }, [info.sudoMode]);

  const setSudoOn = useCallback((on: boolean) => {
    if (on && !unlocked) { setAskPassword(true); return; }
    setSudo(on);
    setVersion((v) => v + 1);
  }, [unlocked]);

  // Poll while any scan is running; refresh views when one finishes.
  const running = [...scans.values()].some((s) => s.state === 'running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const list = await loadScans().catch(() => []);
      if (!list.some((s) => s.state === 'running')) {
        setVersion((v) => v + 1);
        const failed = list.find((s) => s.state === 'error');
        if (failed) toast(`Scan of ${failed.root} failed: ${failed.error}`, true);
      }
    }, 600);
    return () => clearInterval(t);
  }, [running, loadScans, toast]);

  const sudoAvailable = info.sudoMode !== 'none';
  const ws = useMemo<Ws>(() => ({
    info, sudo, sudoAvailable, disks, scans, version,
    requestSudo: () => setSudoOn(true),
    refresh: () => { setVersion((v) => v + 1); loadDisks(); loadScans().catch(() => {}); },
    startScan: async (root) => {
      try {
        const s = await api.startScan(root, sudo);
        setScans((m) => new Map(m).set(root, s));
      } catch (e) { toast((e as Error).message, true); }
    },
    cancelScan: async (root) => { await api.cancelScan(root).catch(() => {}); await loadScans().catch(() => {}); },
  }), [info, sudo, sudoAvailable, setSudoOn, disks, scans, version, loadDisks, loadScans, toast]);

  return (
    <WsCtx.Provider value={ws}>
      <div className="workspace">
        <header className="topbar">
          <div className="who">
            <div className="title">{info.label}</div>
            <div className="muted small">{info.hostname} · {info.os}</div>
          </div>
          <nav className="segmented tabs">
            <button className={tab === 'explore' ? 'active' : ''} onClick={() => setTab('explore')}><TreeIcon size={14} /> Explorer</button>
            <button className={tab === 'cleanup' ? 'active' : ''} onClick={() => setTab('cleanup')}><Sparkles size={14} /> Cleanup</button>
          </nav>
          <div className="spacer" />
          {isRoot ? (
            <span className="badge" title="Connected as root, so every file is visible"><ShieldCheck size={12} /> root</span>
          ) : (
            <label className="toggle" title={sudoAvailable
              ? 'Run commands as root so files owned by root (Docker data, logs) are measured and can be cleaned'
              : 'This user cannot use sudo, so only files it can read are shown'}>
              <input type="checkbox" checked={sudo} disabled={!sudoAvailable} onChange={(e) => setSudoOn(e.target.checked)} />
              Use sudo
              {info.sudoMode === 'password' && !unlocked && <LockKeyhole size={13} className="muted" />}
            </label>
          )}
          <button onClick={onDisconnect}><LogOut size={14} /> Disconnect</button>
        </header>
        <DiskBar selected={mount} onSelect={(m) => { setMount(m); setTab('explore'); }} />
        <main className="content">
          {tab === 'explore' ? <Explorer key={mount} root={mount} /> : <Cleanup />}
        </main>
      </div>
      {askPassword && (
        <SudoDialog
          user={info.label.split('@')[0]}
          onClose={() => setAskPassword(false)}
          onUnlocked={() => {
            setAskPassword(false);
            setUnlocked(true);
            setSudo(true);
            setVersion((v) => v + 1);
            toast('sudo is on. Rescan to include files only root can read.');
          }}
        />
      )}
    </WsCtx.Provider>
  );
}

function SudoDialog({ user, onClose, onUnlocked }: { user: string; onClose: () => void; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.unlockSudo(password);
      setPassword('');
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={<><LockKeyhole size={18} /> sudo password</>} onClose={onClose}>
      <form onSubmit={submit}>
        <p>Files owned by root, such as Docker data and container volumes, are only visible with sudo.
          Enter the sudo password for <b>{user}</b> on this VM.</p>
        <input type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="muted small">Kept only in this app's memory for this connection and sent to the VM over SSH. Never saved to disk.</p>
        {error && <div className="error-box">{error}</div>}
        <div className="modal-foot flush">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!password || busy}>{busy ? <><Spinner /> Checking…</> : 'Use sudo'}</button>
        </div>
      </form>
    </Modal>
  );
}
