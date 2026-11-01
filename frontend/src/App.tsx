import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { api, setAuthLostListener, setSessionId } from './api';
import type { SessionInfo } from './types';
import { ConnectScreen } from './components/ConnectScreen';
import { Workspace } from './components/Workspace';
import { Spinner } from './ui';

type View = { kind: 'checking' } | { kind: 'locked' } | { kind: 'connect'; message?: string } | { kind: 'app'; info: SessionInfo };

const INFO_KEY = 'vmsm.info';

export default function App() {
  const [view, setView] = useState<View>({ kind: 'checking' });

  useEffect(() => {
    setAuthLostListener((reason) => {
      if (reason === 'locked') setView({ kind: 'locked' });
      else {
        setSessionId('');
        sessionStorage.removeItem(INFO_KEY);
        setView((v) => v.kind === 'app' ? { kind: 'connect', message: 'The SSH session ended. Please reconnect.' } : v);
      }
    });
    // Resume an SSH session that is still open on the server (e.g. after a page reload).
    const saved = sessionStorage.getItem(INFO_KEY);
    api.session()
      .then(() => setView(saved ? { kind: 'app', info: JSON.parse(saved) } : { kind: 'connect' }))
      .catch((e) => { if (e.status !== 401 || e.data?.code !== 'locked') setView({ kind: 'connect' }); });
  }, []);

  if (view.kind === 'checking') return <div className="center-screen"><Spinner /></div>;

  if (view.kind === 'locked') {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <Lock size={22} />
          <h1>Locked</h1>
          <p className="muted">
            This app only works from the sign-in link printed in the terminal where you ran <span className="mono">bun start</span>.
            Open that link in this browser to unlock it.
          </p>
        </div>
      </div>
    );
  }

  if (view.kind === 'connect') {
    return (
      <ConnectScreen
        message={view.message}
        onConnected={(info) => {
          setSessionId(info.id);
          sessionStorage.setItem(INFO_KEY, JSON.stringify(info));
          setView({ kind: 'app', info });
        }}
      />
    );
  }

  return (
    <Workspace
      info={view.info}
      onDisconnect={async () => {
        await api.disconnect().catch(() => {});
        setSessionId('');
        sessionStorage.removeItem(INFO_KEY);
        setView({ kind: 'connect' });
      }}
    />
  );
}
