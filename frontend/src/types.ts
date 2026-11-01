export type SudoMode = 'root' | 'nopasswd' | 'password' | 'none';

export type SessionInfo = { id: string; label: string; os: string; hostname: string; sudoMode: SudoMode };

export type SshHost = { alias: string; host: string; user?: string; port?: number; keyPath?: string };

export type Disk = { fs: string; total: number; used: number; avail: number; mount: string };

export type ScanStatus = {
  root: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  sudo: boolean;
  dirs: number;
  current: string;
  denied: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  stale: boolean;
  total: number;
};

export type TreeNode = { name: string; path: string; size: number; mount: boolean; incomplete?: boolean; hasChildren: boolean };

export type FileEntry = { name: string; path: string; size: number; type: 'file' | 'link' | 'other'; mtime: number };

export type Contents = {
  path: string;
  size: number;
  indexed: boolean;
  stale: boolean;
  incomplete: boolean;
  denied: number;
  dirs: TreeNode[];
  files: FileEntry[];
  fileCount: number;
  filesSize: number;
};

export type LargeFile = { path: string; size: number; mtime: number };

export type CleanupTarget = {
  id: string;
  level: 'safe' | 'force';
  label: string;
  description: string;
  warning?: string;
  root: boolean;
  upTo?: boolean;
  available: boolean;
  needsSudo: boolean;
  bytes: number;
  items?: number;
};

export type CleanResult = { id: string; label: string; ok: boolean; output: string };
