import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Sparkles, XCircle, Zap } from 'lucide-react';
import { api } from '../api';
import type { CleanResult, CleanupTarget } from '../types';
import { fmtBytes } from '../format';
import { Confirm, Modal, Spinner } from '../ui';
import { useWs } from './Workspace';

export function Cleanup() {
  const { sudo, sudoAvailable, requestSudo, refresh } = useWs();
  const [targets, setTargets] = useState<CleanupTarget[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showForce, setShowForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<{ results: CleanResult[]; freed: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { targets } = await api.cleanupTargets(sudo);
      setTargets(targets);
      setSelected(new Set(targets.filter((t) => t.level === 'safe' && t.available).map((t) => t.id)));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }, [sudo]);

  useEffect(() => { load(); }, [load]);

  const chosen = useMemo(() => (targets ?? []).filter((t) => selected.has(t.id)), [targets, selected]);
  const chosenForce = chosen.filter((t) => t.level === 'force');
  const estimate = chosen.reduce((n, t) => n + t.bytes, 0);

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const run = async () => {
    const usedBefore = (await api.disks()).disks.reduce((n, d) => n + d.used, 0);
    const { results } = await api.runCleanup(chosen.map((t) => t.id), sudo, chosenForce.length > 0);
    const usedAfter = (await api.disks()).disks.reduce((n, d) => n + d.used, 0);
    setResults({ results, freed: Math.max(0, usedBefore - usedAfter) });
    refresh();
    load();
  };

  const safe = (targets ?? []).filter((t) => t.level === 'safe');
  const force = (targets ?? []).filter((t) => t.level === 'force');

  return (
    <div className="cleanup">
      <div className="cleanup-head">
        <div>
          <h2><Sparkles size={18} /> Clean up space</h2>
          <p className="muted">Finds caches, old logs and leftovers that are safe to remove. Nothing is deleted until you confirm.</p>
          {!sudo && (
            <p className="warn-text small">
              {sudoAvailable
                ? <>System-wide items (logs, apt, Docker) need root. <button className="link" onClick={requestSudo}>Use sudo</button> to include them.</>
                : 'This user cannot use sudo, so only its own files can be cleaned.'}
            </p>
          )}
        </div>
        <button onClick={load} disabled={loading}>{loading ? <Spinner /> : <RefreshCw size={14} />} Re-check</button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!targets && !error && <div className="empty"><Spinner /> Checking what can be cleaned…</div>}

      {targets && (
        <>
          <Section icon={<ShieldCheck size={16} />} title="Safe cleanup" note="Things that rebuild themselves. Nothing you need is lost." tone="safe">
            {safe.map((t) => <TargetRow key={t.id} t={t} checked={selected.has(t.id)} onToggle={() => toggle(t.id)} />)}
          </Section>

          <Section icon={<Zap size={16} />} title="Force cleanup" tone="force"
            note="Frees more space but removes things you might still want. Read each warning."
            action={<button className="link" onClick={() => setShowForce((v) => !v)}>{showForce ? 'Hide' : 'Show force options'}</button>}>
            {showForce && force.map((t) => <TargetRow key={t.id} t={t} checked={selected.has(t.id)} onToggle={() => toggle(t.id)} />)}
          </Section>

          <div className="cleanup-bar">
            <div>
              <b>{chosen.length}</b> selected · about <b>{fmtBytes(estimate)}</b>
              {chosenForce.length > 0 && <span className="badge danger"><AlertTriangle size={12} /> {chosenForce.length} force</span>}
            </div>
            <button className={chosenForce.length ? 'danger' : 'primary'} disabled={!chosen.length} onClick={() => setConfirming(true)}>
              Clean selected
            </button>
          </div>
        </>
      )}

      {confirming && (
        <Confirm
          title={chosenForce.length ? 'Run force cleanup?' : 'Run cleanup?'}
          actionLabel={chosenForce.length ? 'Force clean' : 'Clean'}
          danger={chosenForce.length > 0}
          requireText={chosenForce.length ? 'FORCE' : undefined}
          onClose={() => setConfirming(false)}
          onConfirm={run}
        >
          <ul className="confirm-list">
            {chosen.map((t) => (
              <li key={t.id}>
                <span>{t.label}</span>
                <span className="num muted">{t.items !== undefined ? `${t.items} packages` : `${t.upTo ? 'up to ' : ''}${fmtBytes(t.bytes)}`}</span>
              </li>
            ))}
          </ul>
          {chosenForce.map((t) => (
            <div key={t.id} className="danger-box small"><AlertTriangle size={14} /><span><b>{t.label}:</b> {t.warning}</span></div>
          ))}
        </Confirm>
      )}

      {results && (
        <Modal title="Cleanup finished" onClose={() => setResults(null)} footer={<button className="primary" onClick={() => setResults(null)}>Done</button>}>
          <p className="freed">Freed <b>{fmtBytes(results.freed)}</b> on disk.</p>
          {results.results.map((r) => (
            <details key={r.id} className="result" open={!r.ok}>
              <summary>{r.ok ? <CheckCircle2 size={15} className="ok-text" /> : <XCircle size={15} className="error-text" />} {r.label}</summary>
              {r.output && <pre>{r.output}</pre>}
            </details>
          ))}
        </Modal>
      )}
    </div>
  );
}

function Section({ icon, title, note, tone, action, children }: {
  icon: ReactNode; title: string; note: string; tone: 'safe' | 'force'; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className={`clean-section ${tone}`}>
      <div className="clean-section-head">
        <div><h3>{icon} {title}</h3><span className="muted small">{note}</span></div>
        {action}
      </div>
      {children}
    </section>
  );
}

function TargetRow({ t, checked, onToggle }: { t: CleanupTarget; checked: boolean; onToggle: () => void }) {
  const disabled = !t.available;
  const size = t.items !== undefined
    ? (t.items ? `${t.items} packages` : 'nothing')
    : t.available ? `${t.upTo ? 'up to ' : ''}${fmtBytes(t.bytes)}` : t.needsSudo ? 'needs sudo' : 'nothing to clean';
  return (
    <label className={`target-row ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={onToggle} />
      <div className="target-text">
        <div className="target-label">{t.label}</div>
        <div className="muted small">{t.description}</div>
        {t.warning && !disabled && <div className="warn-text small"><AlertTriangle size={12} /> {t.warning}</div>}
      </div>
      <div className={`target-size num ${t.available ? '' : 'muted'}`}>{size}</div>
    </label>
  );
}
