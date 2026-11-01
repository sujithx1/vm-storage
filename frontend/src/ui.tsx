import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

/* ---------- Toasts ---------- */

type Toast = { id: number; message: string; error: boolean };
const ToastCtx = createContext<(message: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const show = useCallback((message: string, error = false) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal ---------- */

export function Modal({ title, onClose, children, wide, footer }: {
  title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A confirmation dialog whose action shows progress and reports errors. */
export function Confirm({ title, children, actionLabel, danger = true, requireText, onConfirm, onClose }: {
  title: string; children: ReactNode; actionLabel: string; danger?: boolean; requireText?: string;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const toast = useToast();
  const blocked = !!requireText && typed.trim() !== requireText;
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className={danger ? 'danger' : 'primary'} onClick={run} disabled={busy || blocked}>
          {busy ? <><Spinner /> Working…</> : actionLabel}
        </button>
      </>}
    >
      {children}
      {requireText && (
        <label className="field">
          <span>Type <b className="mono">{requireText}</b> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
        </label>
      )}
    </Modal>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden />;

export function Meter({ pct, className = '' }: { pct: number; className?: string }) {
  return <div className={`meter ${className}`}><div style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>;
}
