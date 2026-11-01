import { checkSudo, fail, run, type Session } from './ssh';

/**
 * Every cleanup is a fixed command defined here. The browser only sends target ids,
 * so it can never make the server run arbitrary shell commands.
 *
 * `detect` prints lines the server sums up:
 *   "<kb>"       size in KB
 *   "h:<size>"   Docker-style human size (e.g. 1.2GB)
 *   "n:<count>"  number of items when a size can't be known up front
 */
type Target = {
  id: string;
  level: 'safe' | 'force';
  label: string;
  description: string;
  warning?: string;
  root: boolean; // needs sudo
  upTo?: boolean; // detected size is the most it can free, not exact
  detect: string;
  clean: string;
};

const PRELUDE = `
kb() { du -sck "$@" 2>/dev/null | tail -1 | cut -f1; }
fsum() { awk '{s+=$1} END {print s+0}'; }
if [ "$(id -u)" = 0 ]; then HOMES="/root $(ls -d /home/*/ 2>/dev/null | sed 's:/$::' | tr '\\n' ' ')"; else HOMES="$HOME"; fi
has() { command -v "$1" >/dev/null 2>&1; }
dockerok() { has docker && docker info >/dev/null 2>&1; }
`;

const ROTATED = `\\( -name '*.gz' -o -name '*.xz' -o -name '*.bz2' -o -name '*.zst' -o -name '*.[0-9]' -o -name '*.old' \\)`;
const PKG_CACHES = '.cache/pip .npm/_cacache .cache/yarn .yarn/berry/cache .bun/install/cache .cache/go-build .cache/composer .cache/node-gyp .cache/thumbnails';

export const TARGETS: Target[] = [
  {
    id: 'apt-cache', level: 'safe', root: true,
    label: 'APT package downloads',
    description: 'Downloaded .deb installers in /var/cache/apt. apt downloads them again if it ever needs them.',
    detect: `has apt-get && kb /var/cache/apt/archives/*.deb /var/cache/apt/*.bin`,
    clean: `DEBIAN_FRONTEND=noninteractive apt-get clean`,
  },
  {
    id: 'journal-old', level: 'safe', root: true, upTo: true,
    label: 'System journal older than 7 days',
    description: 'journald logs from more than a week ago. Recent logs are kept.',
    detect: `has journalctl && [ -d /var/log/journal ] && kb /var/log/journal`,
    clean: `journalctl --vacuum-time=7d`,
  },
  {
    id: 'rotated-logs-old', level: 'safe', root: true,
    label: 'Old rotated logs (7+ days)',
    description: 'Compressed or numbered log files (syslog.2.gz, nginx/access.log.1 …) in /var/log older than a week. Current logs are untouched.',
    detect: `find /var/log -xdev -type f ${ROTATED} -mtime +7 -printf '%k\\n' 2>/dev/null | fsum`,
    clean: `find /var/log -xdev -type f ${ROTATED} -mtime +7 -delete`,
  },
  {
    id: 'pkg-caches', level: 'safe', root: false,
    label: 'Developer package caches',
    description: 'pip, npm, yarn, bun, Go build, composer and node-gyp download caches in home folders. They refill on the next install.',
    detect: `for h in $HOMES; do for d in ${PKG_CACHES}; do [ -d "$h/$d" ] && echo "$h/$d"; done; done | while read -r p; do kb "$p"; done | fsum`,
    clean: `for h in $HOMES; do for d in ${PKG_CACHES}; do [ -d "$h/$d" ] && rm -rf -- "$h/$d"; done; done; true`,
  },
  {
    id: 'tmp-old', level: 'safe', root: false,
    label: 'Temp files unused for 10+ days',
    description: 'Files in /tmp and /var/tmp nobody has opened in 10 days.',
    detect: `find /tmp /var/tmp -xdev -mindepth 1 -type f -atime +10 -printf '%k\\n' 2>/dev/null | fsum`,
    clean: `find /tmp /var/tmp -xdev -mindepth 1 -type f -atime +10 -delete 2>/dev/null; true`,
  },
  {
    id: 'crash-dumps', level: 'safe', root: true,
    label: 'Crash reports and core dumps',
    description: 'Leftovers from programs that crashed (/var/crash, systemd coredumps).',
    detect: `kb /var/crash/* /var/lib/systemd/coredump/*`,
    clean: `rm -rf /var/crash/* /var/lib/systemd/coredump/*`,
  },
  {
    id: 'snap-old', level: 'safe', root: true,
    label: 'Old snap versions',
    description: 'Disabled older revisions snap keeps around after updates.',
    detect: `has snap && snap list --all 2>/dev/null | awk '/disabled/{print $1"_"$3}' | while read -r s; do kb "/var/lib/snapd/snaps/$s.snap"; done | fsum`,
    clean: `snap list --all | awk '/disabled/{print $1, $3}' | while read -r n r; do snap remove "$n" --revision="$r"; done`,
  },
  {
    id: 'docker-dangling', level: 'safe', root: true,
    label: 'Docker build cache and dangling images',
    description: 'Untagged image layers and build cache. Images you use and all containers are kept.',
    detect: `dockerok && { docker images -f dangling=true --format 'h:{{.Size}}'; docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '/Build Cache/{split($2,a," "); print "h:"a[1]}'; }`,
    clean: `docker image prune -f && docker builder prune -f`,
  },

  {
    id: 'journal-shrink', level: 'force', root: true, upTo: true,
    label: 'Shrink system journal to 50 MB',
    description: 'Deletes all but the newest ~50 MB of journald logs.',
    warning: 'Older system logs are gone for good. You lose history you might need to investigate past problems.',
    detect: `has journalctl && [ -d /var/log/journal ] && kb /var/log/journal`,
    clean: `journalctl --vacuum-size=50M`,
  },
  {
    id: 'rotated-logs-all', level: 'force', root: true,
    label: 'All rotated logs',
    description: 'Every compressed or numbered log file in /var/log, whatever its age.',
    warning: 'All past log files are deleted. Only the live log files remain.',
    detect: `find /var/log -xdev -type f ${ROTATED} -printf '%k\\n' 2>/dev/null | fsum`,
    clean: `find /var/log -xdev -type f ${ROTATED} -delete`,
  },
  {
    id: 'big-active-logs', level: 'force', root: true,
    label: 'Empty live logs over 100 MB',
    description: 'Clears *.log files in /var/log larger than 100 MB, in place, so running services keep writing to them.',
    warning: 'The contents of these logs are erased. Services keep running.',
    detect: `find /var/log -xdev -type f -name '*.log' -size +100M -printf '%k\\n' 2>/dev/null | fsum`,
    clean: `find /var/log -xdev -type f -name '*.log' -size +100M -exec truncate -s 0 {} +`,
  },
  {
    id: 'tmp-all', level: 'force', root: false,
    label: 'All files in /tmp and /var/tmp',
    description: 'Every regular file in the temp folders, however recent.',
    warning: 'Programs that are running right now may be using these files and could fail or lose unsaved work.',
    detect: `find /tmp /var/tmp -xdev -mindepth 1 -type f -printf '%k\\n' 2>/dev/null | fsum`,
    clean: `find /tmp /var/tmp -xdev -mindepth 1 -type f -delete 2>/dev/null; true`,
  },
  {
    id: 'home-cache-all', level: 'force', root: false,
    label: 'Entire ~/.cache of every user',
    description: 'All of ~/.cache, not just package-manager caches (browsers, IDE indexes, Playwright browsers …).',
    warning: 'Apps rebuild these, but first runs become slow and large items (e.g. Playwright browsers) download again.',
    detect: `for h in $HOMES; do [ -d "$h/.cache" ] && kb "$h/.cache"; done | fsum`,
    clean: `for h in $HOMES; do [ -d "$h/.cache" ] && rm -rf -- "$h/.cache"; done; true`,
  },
  {
    id: 'docker-unused', level: 'force', root: true,
    label: 'Docker: all unused images and stopped containers',
    description: 'Runs docker system prune -a: stopped containers, unused networks, every image no running container uses, all build cache.',
    warning: 'Stopped containers are deleted with their data, and images must be pulled again before you can start them.',
    detect: `dockerok && docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '!/Volumes/{split($2,a," "); print "h:"a[1]}'`,
    clean: `docker system prune -a -f`,
  },
  {
    id: 'docker-volumes', level: 'force', root: true,
    label: 'Docker: unused volumes',
    description: 'Volumes not attached to any container, including named ones.',
    warning: 'DATA LOSS. Databases and uploads kept in Docker volumes are permanently deleted if their container is not running.',
    detect: `dockerok && docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '/Volumes/{split($2,a," "); print "h:"a[1]}'`,
    clean: `docker volume prune -a -f 2>/dev/null || docker volume prune -f`,
  },
  {
    id: 'apt-autoremove', level: 'force', root: true,
    label: 'Unused packages and old kernels',
    description: 'apt autoremove --purge: packages that were installed as dependencies and are no longer needed, plus old kernels.',
    warning: 'Occasionally removes a package you rely on but never installed directly. Review with "apt autoremove --dry-run" if unsure.',
    detect: `has apt-get && echo "n:$(apt-get -s autoremove 2>/dev/null | grep -c '^Remv')"`,
    clean: `DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge`,
  },
];

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
function parseHuman(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([kKMGT]?B)$/);
  return m ? Number(m[1]) * (UNITS[m[2].toUpperCase()] ?? 1) : 0;
}

function parseDetect(out: string) {
  let bytes = 0, items: number | undefined, found = false;
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('h:')) { bytes += parseHuman(line.slice(2)); found = true; }
    else if (line.startsWith('n:')) { items = Number(line.slice(2)) || 0; found = true; }
    else if (/^\d+$/.test(line)) { bytes += Number(line) * 1024; found = true; }
  }
  return { found, bytes: Math.round(bytes), items };
}

export async function detect(s: Session, sudo: boolean) {
  const usable = TARGETS.filter((t) => sudo || !t.root);
  const script = PRELUDE + usable.map((t) => `echo "@@${t.id}"; ( ${t.detect} ) 2>/dev/null`).join('\n');
  const { stdout, stderr } = await run(s, script, { sudo });
  checkSudo(stderr);

  const sections = new Map<string, string>();
  for (const part of stdout.split('@@').slice(1)) {
    const nl = part.indexOf('\n');
    sections.set(nl < 0 ? part.trim() : part.slice(0, nl).trim(), nl < 0 ? '' : part.slice(nl + 1));
  }
  return TARGETS.map((t) => {
    const r = parseDetect(sections.get(t.id) ?? '');
    const { detect: _d, clean: _c, ...info } = t;
    return {
      ...info,
      // Ignore near-empty results (an empty journal folder is still 4 KB) so only worthwhile items are offered.
      available: usable.includes(t) && r.found && (r.bytes >= 256 * 1024 || (r.items ?? 0) > 0),
      needsSudo: t.root && !sudo,
      bytes: r.bytes,
      items: r.items,
    };
  });
}

export async function clean(s: Session, ids: string[], sudo: boolean, force: boolean) {
  const chosen = TARGETS.filter((t) => ids.includes(t.id));
  if (!chosen.length) throw fail(400, 'Nothing selected');
  if (chosen.some((t) => t.level === 'force') && !force) throw fail(400, 'Force cleanups need explicit confirmation');
  if (chosen.some((t) => t.root) && !sudo) throw fail(400, 'Some selected cleanups need sudo');

  const results = [];
  for (const t of chosen) {
    // Same sudo setting as detect, so what gets cleaned matches the size that was shown.
    const { code, stdout, stderr } = await run(s, PRELUDE + t.clean, { sudo, timeoutMs: 20 * 60_000 });
    checkSudo(stderr);
    const output = (stdout + stderr).trim().split('\n').slice(-12).join('\n');
    results.push({ id: t.id, label: t.label, ok: code === 0, output });
  }
  for (const scan of s.scans.values()) if (scan.state === 'done') scan.stale = true;
  return results;
}
