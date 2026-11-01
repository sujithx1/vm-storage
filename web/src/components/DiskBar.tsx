import { HardDrive } from 'lucide-react';
import { fmtBytes, pctClass } from '../format';
import { Meter } from '../ui';
import { useWs } from './Workspace';

export function DiskBar({ selected, onSelect }: { selected: string; onSelect: (mount: string) => void }) {
  const { disks, scans } = useWs();
  return (
    <div className="disks">
      {disks.map((d) => {
        const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
        const scan = scans.get(d.mount);
        return (
          <button key={d.mount} className={`disk ${selected === d.mount ? 'active' : ''}`} onClick={() => onSelect(d.mount)} title={d.fs}>
            <div className="disk-head">
              <HardDrive size={14} />
              <span className="mount">{d.mount}</span>
              <span className={`pct ${pctClass(pct)}`}>{pct}%</span>
            </div>
            <Meter pct={pct} className={pctClass(pct)} />
            <div className="muted small">
              {fmtBytes(d.avail)} free of {fmtBytes(d.total)}
              {scan?.state === 'running' && ' · scanning…'}
              {scan?.state === 'done' && ' · scanned'}
            </div>
          </button>
        );
      })}
    </div>
  );
}
