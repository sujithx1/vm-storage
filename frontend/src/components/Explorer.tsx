import { useState } from 'react';
import { Radar, Square } from 'lucide-react';
import { fmtAgo, fmtBytes, fmtNum } from '../format';
import { Spinner } from '../ui';
import { useWs } from './Workspace';
import { FolderTree } from './FolderTree';
import { FolderPanel } from './FolderPanel';

export function Explorer({ root }: { root: string }) {
  const { scans, startScan, cancelScan } = useWs();
  const [selected, setSelected] = useState(root);
  const scan = scans.get(root);

  return (
    <div className="explorer">
      <section className="pane tree-pane">
        <div className="pane-head">
          <span className="pane-title">Folders by size</span>
          {scan?.state === 'done' && (
            <span className="muted small">
              {scan.stale ? <span className="warn-text">sizes changed · </span> : null}
              scanned {fmtAgo(scan.finishedAt!)}{' '}
              <button className="link" onClick={() => startScan(root)}>Rescan</button>
            </span>
          )}
        </div>
        {scan?.state === 'done' ? (
          <FolderTree root={root} selected={selected} onSelect={setSelected} />
        ) : scan?.state === 'running' ? (
          <div className="scan-state">
            <Spinner />
            <div><b>Scanning {root}</b></div>
            <div className="muted">{fmtNum(scan.dirs)} folders measured · {Math.round((Date.now() - scan.startedAt) / 1000)}s</div>
            <div className="mono small current" title={scan.current}>{scan.current}</div>
            <button onClick={() => cancelScan(root)}><Square size={12} /> Stop</button>
          </div>
        ) : (
          <div className="scan-state">
            <Radar size={28} className="muted" />
            <div><b>Scan {root} once to see every folder's size</b></div>
            <div className="muted small">
              The scan measures the whole disk a single time (a few seconds to a few minutes on big disks).
              After that, browsing is instant.
            </div>
            {scan?.state === 'error' && <div className="error-box">{scan.error}</div>}
            {scan?.state === 'cancelled' && <div className="muted small">Last scan was stopped.</div>}
            <button className="primary" onClick={() => startScan(root)}>Scan {root}</button>
          </div>
        )}
        {scan?.state === 'done' && scan.denied > 0 && (
          <div className="pane-foot warn-text small">{fmtNum(scan.denied)} folders could not be read{' '}(turn on “Use sudo” and rescan)</div>
        )}
        {scan?.state === 'done' && <div className="pane-foot muted small">{fmtNum(scan.dirs)} folders · {fmtBytes(scan.total)} used</div>}
      </section>
      <section className="pane panel-pane">
        <FolderPanel path={selected} root={root} onOpen={setSelected} />
      </section>
    </div>
  );
}
