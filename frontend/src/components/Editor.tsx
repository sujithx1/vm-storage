import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal, Spinner, useToast } from '../ui';
import { useWs } from './Workspace';

export function Editor({ path, onClose }: { path: string; onClose: () => void }) {
  const { sudo, refresh } = useWs();
  const toast = useToast();
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.readFile(path, sudo)
      .then((r) => { setOriginal(r.content); setText(r.content); })
      .catch((e) => { toast(e.message, true); onClose(); });
  }, [path, sudo]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = original !== null && text !== original;

  const save = async () => {
    setSaving(true);
    try {
      await api.writeFile(path, text, sudo);
      setOriginal(text);
      toast(`Saved ${path}`);
      refresh();
    } catch (e) { toast((e as Error).message, true); }
    setSaving(false);
  };

  const close = () => { if (!dirty || confirm('Discard unsaved changes?')) onClose(); };

  return (
    <Modal wide title={<span className="mono">{path}</span>} onClose={close}
      footer={<>
        <span className="muted small grow">{dirty ? 'Unsaved changes · ⌘S to save' : original !== null ? `${text.split('\n').length} lines` : ''}</span>
        <button onClick={close}>Close</button>
        <button className="primary" onClick={save} disabled={!dirty || saving}>{saving ? <><Spinner /> Saving…</> : 'Save'}</button>
      </>}>
      {original === null ? <div className="empty"><Spinner /> Opening…</div> : (
        <textarea
          className="editor"
          value={text}
          spellCheck={false}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty) save(); }
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget, s = el.selectionStart, end = el.selectionEnd;
              setText(text.slice(0, s) + '  ' + text.slice(end));
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
      )}
    </Modal>
  );
}
