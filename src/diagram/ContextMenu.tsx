import { useLayoutEffect, useRef, useState } from 'react';
import { deleteProcess } from '../core/edits';
import { isDelay, type IRSystem } from '../core/ir';
import { POPOVER_MARGIN } from './Popovers';

export type MenuTarget =
  | { kind: 'node'; name: string }
  | { kind: 'edge'; edgeId: string; signalName: string }
  | { kind: 'canvas' };

export interface MenuItem {
  label: string;
  /** Handled by App through the same staleness-guarded path as the EditPopover. */
  action: string;
  disabledReason?: string;
}

const DELETE_REFUSAL = 'only single-input single-output processes can be deleted here';

function deleteItem(ir: IRSystem, name: string): MenuItem {
  return deleteProcess(ir, name)
    ? { label: 'delete', action: 'delete' }
    : { label: 'delete', action: 'delete', disabledReason: DELETE_REFUSAL };
}

/** Pure builder: which menu rows a right-click target gets, and which are refused. */
export function menuItems(target: MenuTarget, ir: IRSystem | null): MenuItem[] {
  if (!ir) return [];
  if (target.kind === 'canvas')
    return [
      { label: 'add actor', action: 'add-actor' },
      { label: 'fit view', action: 'fit-view' },
    ];
  if (target.kind === 'edge') {
    const sig = ir.signals.find((s) => s.name === target.signalName);
    if (!sig) return [];
    return [
      { label: 'insert actor', action: 'insert-actor' },
      { label: 'insert delay', action: 'insert-delay' },
      { label: `rename signal ${sig.name}`, action: 'rename-signal' },
    ];
  }
  const p = ir.processes.find((q) => q.name === target.name);
  if (!p) return [];
  if (isDelay(p))
    return [
      { label: `rename ${p.name}`, action: 'rename' },
      { label: 'set tokens', action: 'tokens' },
      deleteItem(ir, p.name),
    ];
  return [
    { label: `rename ${p.name}`, action: 'rename' },
    { label: 'set rates', action: 'rates' },
    { label: 'set function', action: 'function' },
    p.function === 'NULL'
      ? { label: 'goto definition', action: 'goto-definition', disabledReason: 'function is undefined' }
      : { label: `goto ${p.function}`, action: 'goto-definition' },
    deleteItem(ir, p.name),
  ];
}

interface MenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onPick(action: string): void;
  onClose(): void;
}

/** Dumb positioned menu: same clamp and .popover CSS as the EditPopover. */
export function Menu({ x, y, items, onPick, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // delete arms on first click, fires on the second (two-step, like the popover)
  const [armed, setArmed] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    const pane = el?.offsetParent as HTMLElement | null;
    if (!el || !pane) return;
    setPos({
      x: Math.max(POPOVER_MARGIN, Math.min(x, pane.clientWidth - el.offsetWidth - POPOVER_MARGIN)),
      y: Math.max(POPOVER_MARGIN, Math.min(y, pane.clientHeight - el.offsetHeight - POPOVER_MARGIN)),
    });
  }, [x, y]);

  if (!items.length) return null;

  return (
    <div
      className="popover"
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.action}
          role="menuitem"
          autoFocus={i === 0}
          disabled={!!item.disabledReason}
          title={item.disabledReason}
          onClick={() => {
            if (item.action === 'delete' && !armed) {
              setArmed(true);
              return;
            }
            onPick(item.action);
          }}
        >
          {item.action === 'delete' && armed ? 'confirm delete?' : item.label}
        </button>
      ))}
    </div>
  );
}
