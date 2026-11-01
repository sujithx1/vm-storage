import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { FolderTree as TreeIcon, LogOut, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { Disk, ScanStatus, SessionInfo } from '../types';
import { useToast } from '../ui';
import { DiskBar } from './DiskBar';
import { Explorer } from './Explorer';
import { Cleanup } from './Cleanup';

type Ws = {
  info: SessionInfo;
  sudo: boolean;
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
  const [sudo, setSudo] = useState(info.sudo);
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

  const ws = useMemo<Ws>(() => ({
    info, sudo, disks, scans, version,
    refresh: () => { setVersion((v) => v + 1); loadDisks(); loadScans().catch(() => {}); },
    startScan: async (root) => {
      try {
        const s = await api.startScan(root, sudo);
        setScans((m) => new Map(m).set(root, s));
      } catch (e) { toast((e as Error).message, true); }
    },
    cancelScan: async (root) => { await api.cancelScan(root).catch(() => {}); await loadScans().catch(() => {}); },
  }), [info, sudo, disks, scans, version, loadDisks, loadScans, toast]);

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
          <label className="toggle" title={info.sudo
            ? 'Run commands with sudo so you can see and clean files owned by root'
            : 'This user has no passwordless sudo, so only files it can read are shown'}>
            <input type="checkbox" checked={sudo} disabled={!info.sudo} onChange={(e) => { setSudo(e.target.checked); setVersion((v) => v + 1); }} />
            Use sudo
          </label>
          <button onClick={onDisconnect}><LogOut size={14} /> Disconnect</button>
        </header>
        <DiskBar selected={mount} onSelect={(m) => { setMount(m); setTab('explore'); }} />
        <main className="content">
          {tab === 'explore' ? <Explorer key={mount} root={mount} /> : <Cleanup />}
        </main>
      </div>
    </WsCtx.Provider>
  );
}
