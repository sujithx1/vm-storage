import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Folder, FolderOpen, HardDrive } from 'lucide-react';
import { api } from '../api';
import type { TreeNode } from '../types';
import { fmtBytes } from '../format';
import { useWs } from './Workspace';

type Row = { node: TreeNode; depth: number; parentSize: number };

const ancestors = (root: string, p: string) => {
  const out: string[] = [];
  let cur = p;
  while (cur !== root && cur.length > root.length) {
    cur = cur.replace(/\/[^/]+$/, '') || '/';
    out.push(cur);
  }
  return out;
};

export function FolderTree({ root, selected, onSelect }: { root: string; selected: string; onSelect: (p: string) => void }) {
  const { version, scans } = useWs();
  const [children, setChildren] = useState<Map<string, TreeNode[]>>(new Map());
  const [rootSize, setRootSize] = useState(scans.get(root)?.total ?? 0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root]));
  const loading = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sizes changed (delete, cleanup, rescan): drop the cache; expanded folders reload below.
  useEffect(() => { setChildren(new Map()); loading.current.clear(); }, [version]);

  useEffect(() => {
    for (const p of expanded) {
      if (children.has(p) || loading.current.has(p)) continue;
      loading.current.add(p);
      api.tree(p)
        .then((r) => {
          if (p === root) setRootSize(r.size);
          setChildren((m) => new Map(m).set(p, r.children));
        })
        .catch(() => setChildren((m) => new Map(m).set(p, [])))
        .finally(() => loading.current.delete(p));
    }
  }, [expanded, children, root]);

  // Opening a folder from the right-hand panel reveals it in the tree.
  useEffect(() => {
    const need = ancestors(root, selected).filter((a) => !expanded.has(a));
    if (need.length) setExpanded((s) => new Set([...s, ...need]));
  }, [selected, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (node: TreeNode, depth: number, parentSize: number) => {
      out.push({ node, depth, parentSize });
      if (!expanded.has(node.path)) return;
      for (const child of children.get(node.path) ?? []) walk(child, depth + 1, node.size);
    };
    walk({ name: root, path: root, size: rootSize, mount: true, hasChildren: true }, 0, rootSize);
    return out;
  }, [children, expanded, root, rootSize]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  useEffect(() => {
    const i = rows.findIndex((r) => r.node.path === selected);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' });
  }, [selected, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((p: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);

  return (
    <div className="tree" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const { node, depth, parentSize } = rows[v.index];
          const open = expanded.has(node.path);
          const pct = parentSize ? (node.size / parentSize) * 100 : 0;
          const Icon = node.mount && depth > 0 ? HardDrive : open ? FolderOpen : Folder;
          return (
            <div
              key={node.path}
              className={`tree-row ${selected === node.path ? 'selected' : ''}`}
              style={{ transform: `translateY(${v.start}px)` }}
              onClick={() => onSelect(node.path)}
              onDoubleClick={() => node.hasChildren && toggle(node.path)}
              title={node.path}
            >
              <span className="indent" style={{ width: depth * 14 }} />
              <button
                className={`chev ${open ? 'open' : ''} ${node.hasChildren ? '' : 'hidden'}`}
                onClick={(e) => { e.stopPropagation(); toggle(node.path); }}
                aria-label={open ? 'Collapse' : 'Expand'}
              >
                <ChevronRight size={14} />
              </button>
              <Icon size={15} className="folder-icon" />
              <span className="tree-name">{depth === 0 ? node.path : node.name}</span>
              <span className="tree-size">
                <span className="mini-bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
                <span className="num">{fmtBytes(node.size)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
