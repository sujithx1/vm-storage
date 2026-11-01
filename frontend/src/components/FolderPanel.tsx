import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, Eraser, File, FileCode2, Folder, HardDrive, Link2, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { Contents, LargeFile } from '../types';
import { fmtBytes, fmtDate, fmtNum, parentOf } from '../format';
import { Confirm, Spinner, useToast } from '../ui';
import { useWs } from './Workspace';
import { Editor } from './Editor';

type Item = { kind: 'dir' | 'file' | 'link' | 'other'; name: string; path: string; size: number; mtime?: number; mount?: boolean };
type Dialog =
  | { kind: 'delete'; path: string; size: number; dir: boolean }
  | { kind: 'truncate'; path: string; size: number }
  | { kind: 'edit'; path: string }
  | null;

export function FolderPanel({ path, root, onOpen }: { path: string; root: string; onOpen: (p: string) => void }) {
  const [view, setView] = useState<'contents' | 'largest'>('contents');
  const [dialog, setDialog] = useState<Dialog>(null);

  const crumbs = useMemo(() => {
    const parts = path.split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }));
  }, [path]);

  return (
    <>
      <div className="pane-head">
        <div className="crumbs">
          <button className="icon-btn" disabled={path === root} onClick={() => onOpen(parentOf(path))} title="Up one folder"><ArrowUp size={14} /></button>
          <button className="crumb" onClick={() => onOpen('/')}>/</button>
          {crumbs.map((c, i) => (
            <span key={c.path}>
              {i > 0 && <span className="muted">/</span>}
              <button className="crumb" onClick={() => onOpen(c.path)}>{c.name}</button>
            </span>
          ))}
        </div>
        <nav className="segmented small-seg">
          <button className={view === 'contents' ? 'active' : ''} onClick={() => setView('contents')}>Contents</button>
          <button className={view === 'largest' ? 'active' : ''} onClick={() => setView('largest')}>Largest files</button>
        </nav>
      </div>
      {view === 'contents'
        ? <ContentsList path={path} onOpen={onOpen} setDialog={setDialog} />
        : <LargestFiles path={path} onOpen={onOpen} setDialog={setDialog} />}
      <Dialogs dialog={dialog} close={() => setDialog(null)} />
    </>
  );
}

function ContentsList({ path, onOpen, setDialog }: { path: string; onOpen: (p: string) => void; setDialog: (d: Dialog) => void }) {
  const { sudo, version } = useWs();
  const [data, setData] = useState<Contents | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    api.contents(path, sudo)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setError(e.message); setData(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, sudo, version, reload]);

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const dirs: Item[] = data.dirs.map((d) => ({ kind: 'dir', name: d.name, path: d.path, size: d.size, mount: d.mount }));
    const files: Item[] = data.files.map((f) => ({ kind: f.type, name: f.name, path: f.path, size: f.size, mtime: f.mtime }));
    return [...dirs, ...files].sort((a, b) => b.size - a.size);
  }, [data]);

  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => 40, overscan: 10 });

  if (error) return <div className="empty error-text">{error}</div>;
  if (!data) return <div className="empty"><Spinner /> {loading ? `Reading ${path}…` : ''}</div>;

  const total = data.size || 1;
  return (
    <>
      <div className="panel-summary">
        <div>
          <b>{fmtBytes(data.size)}</b>
          <span className="muted"> · {fmtNum(data.dirs.length)} folders · {fmtNum(data.fileCount)} files</span>
          {!data.indexed && <span className="badge" title="Measured live because this disk has not been scanned">live</span>}
          {data.stale && <span className="badge warn" title="Cleanup ran since the scan; rescan for exact sizes">may be outdated</span>}
          {data.denied > 0 && <span className="badge warn">{data.denied} unreadable</span>}
        </div>
        <button className="icon-btn" onClick={() => setReload((r) => r + 1)} title="Reload">{loading ? <Spinner /> : <RefreshCw size={14} />}</button>
      </div>
      {items.length === 0 ? <div className="empty muted">This folder is empty.</div> : (
        <div className="list" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const it = items[v.index];
              const pct = (it.size / total) * 100;
              const Icon = it.kind === 'dir' ? (it.mount ? HardDrive : Folder) : it.kind === 'link' ? Link2 : /\.(log|txt|conf|cfg|ini|env|ya?ml|json|toml|sh|service)$/i.test(it.name) ? FileCode2 : File;
              return (
                <div key={it.path} className="list-row" style={{ transform: `translateY(${v.start}px)` }}>
                  <button className="row-main" onClick={() => it.kind === 'dir' ? onOpen(it.path) : it.kind === 'file' && setDialog({ kind: 'edit', path: it.path })} title={it.path}>
                    <Icon size={16} className={it.kind === 'dir' ? 'folder-icon' : 'file-icon'} />
                    <span className="row-name">{it.name}{it.mount && <span className="badge">disk</span>}</span>
                    {it.mtime ? <span className="row-date muted small">{fmtDate(it.mtime)}</span> : <span className="row-date" />}
                  </button>
                  <span className="row-bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
                  <span className="row-size num">{fmtBytes(it.size)}</span>
                  <span className="row-pct muted small num">{pct >= 0.1 ? pct.toFixed(1) : '<0.1'}%</span>
                  <span className="row-actions">
                    {it.kind === 'file' && <>
                      <button className="icon-btn" title="Edit" onClick={() => setDialog({ kind: 'edit', path: it.path })}><Pencil size={14} /></button>
                      <button className="icon-btn" title="Empty file (keep it, clear contents)" onClick={() => setDialog({ kind: 'truncate', path: it.path, size: it.size })}><Eraser size={14} /></button>
                    </>}
                    {!it.mount && <button className="icon-btn danger-icon" title="Delete" onClick={() => setDialog({ kind: 'delete', path: it.path, size: it.size, dir: it.kind === 'dir' })}><Trash2 size={14} /></button>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {data.fileCount > data.files.length && (
        <div className="pane-foot muted small">Showing the {fmtNum(data.files.length)} largest of {fmtNum(data.fileCount)} files.</div>
      )}
    </>
  );
}

function LargestFiles({ path, onOpen, setDialog }: { path: string; onOpen: (p: string) => void; setDialog: (d: Dialog) => void }) {
  const { sudo, version } = useWs();
  const [minMb, setMinMb] = useState(100);
  const [files, setFiles] = useState<LargeFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState('');

  const search = async () => {
    setBusy(true); setError('');
    try {
      setFiles((await api.largest(path, minMb, sudo)).files);
      setSearched(path);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  // Results go stale after deletes; refresh them if they were for this folder.
  useEffect(() => { if (searched === path && files) search(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="panel-summary">
        <div className="row-gap">
          <span className="muted">Files bigger than</span>
          <select value={minMb} onChange={(e) => setMinMb(Number(e.target.value))}>
            {[10, 50, 100, 500, 1024].map((n) => <option key={n} value={n}>{n >= 1024 ? '1 GB' : `${n} MB`}</option>)}
          </select>
          <span className="muted">under <span className="mono">{path}</span></span>
        </div>
        <button className="primary" onClick={search} disabled={busy}>{busy ? <><Spinner /> Searching…</> : <><Search size={14} /> Find</>}</button>
      </div>
      {error && <div className="empty error-text">{error}</div>}
      {files && searched === path && (files.length === 0
        ? <div className="empty muted">No files that large here.</div>
        : <div className="list static">
            {files.map((f) => (
              <div key={f.path} className="list-row static">
                <button className="row-main" onClick={() => onOpen(parentOf(f.path))} title="Show in folder">
                  <File size={16} className="file-icon" />
                  <span className="row-name mono small">{f.path}</span>
                  <span className="row-date muted small">{fmtDate(f.mtime)}</span>
                </button>
                <span className="row-size num">{fmtBytes(f.size)}</span>
                <span className="row-actions">
                  <button className="icon-btn" title="Empty file" onClick={() => setDialog({ kind: 'truncate', path: f.path, size: f.size })}><Eraser size={14} /></button>
                  <button className="icon-btn danger-icon" title="Delete" onClick={() => setDialog({ kind: 'delete', path: f.path, size: f.size, dir: false })}><Trash2 size={14} /></button>
                </span>
              </div>
            ))}
          </div>)}
      {!files && !error && <div className="empty muted">Search this folder and everything under it for the biggest files.</div>}
    </>
  );
}

function Dialogs({ dialog, close }: { dialog: Dialog; close: () => void }) {
  const { sudo, refresh } = useWs();
  const toast = useToast();
  if (!dialog) return null;

  if (dialog.kind === 'edit') return <Editor path={dialog.path} onClose={close} />;

  if (dialog.kind === 'truncate') {
    return (
      <Confirm title="Empty this file?" actionLabel="Empty file" onClose={close}
        onConfirm={async () => {
          const r = await api.truncate(dialog.path, sudo);
          toast(`Emptied ${dialog.path} · freed ${fmtBytes(r.freed)}`);
          refresh();
        }}>
        <div className="target mono">{dialog.path}</div>
        <p>The file stays where it is, but its contents (<b>{fmtBytes(dialog.size)}</b>) are cleared.
          This is the right way to shrink a log that a running service is still writing to.</p>
      </Confirm>
    );
  }

  const big = dialog.dir && dialog.size > 1024 ** 3;
  return (
    <Confirm title={`Delete ${dialog.dir ? 'folder' : 'file'}?`} actionLabel="Delete" onClose={close}
      requireText={big ? 'delete' : undefined}
      onConfirm={async () => {
        const r = await api.remove(dialog.path, sudo);
        toast(`Deleted ${dialog.path} · freed ${fmtBytes(r.freed)}`);
        refresh();
      }}>
      <div className="target mono">{dialog.path}</div>
      <p>Frees about <b>{fmtBytes(dialog.size)}</b>.{dialog.dir && ' Everything inside it is removed.'} This cannot be undone.</p>
      <p className="muted small">If a running program still has this file open (a live log, for example), the space only comes back
        after it restarts. Use “Empty” for those instead.</p>
    </Confirm>
  );
}
