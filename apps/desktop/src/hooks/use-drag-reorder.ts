import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useRef,
  useState,
} from "react";

type Drag = { id: string; from: number; to: number };

/** Where a dragged row would land, from the pointer's height over the rows' midpoints. */
function dropIndex(list: HTMLElement, rowSelector: string, y: number, dragged: number): number {
  const rows = [...list.querySelectorAll<HTMLElement>(`:scope > ${rowSelector}`)];
  let index = 0;
  for (const [position, row] of rows.entries()) {
    if (position === dragged) continue;
    const rect = row.getBoundingClientRect();
    if (y > rect.top + rect.height / 2) index++;
  }
  return index;
}

/**
 * A list the user reorders by a grip on each row: dragged with the pointer (rows show in the
 * order they would drop in meanwhile), or moved one place with ↑ and ↓ while the grip has focus.
 * `onMove` gets the row's id and the index it lands at.
 */
export function useDragReorder<T, E extends HTMLElement = HTMLElement>({
  items,
  idOf,
  rowSelector,
  onMove,
}: {
  items: readonly T[];
  idOf: (item: T) => string;
  /** Selects the list's direct children that are rows. */
  rowSelector: string;
  onMove: (id: string, to: number) => void;
}): {
  listRef: RefObject<E | null>;
  /** The items in the order to show them. */
  shown: readonly T[];
  /** The id of the row being dragged. */
  dragging: string | null;
  /** Handlers for a row's grip. */
  grip: (id: string, index: number) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
} {
  const [drag, setDrag] = useState<Drag | null>(null);
  const listRef = useRef<E>(null);
  const shown = drag
    ? (() => {
        const order = items.filter((item) => idOf(item) !== drag.id);
        const moved = items[drag.from];
        if (moved !== undefined) order.splice(drag.to, 0, moved);
        return order;
      })()
    : items;

  const grip = (id: string, index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ id, from: index, to: index });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (!drag || !listRef.current) return;
      const dragged = shown.findIndex((item) => idOf(item) === drag.id);
      const to = dropIndex(listRef.current, rowSelector, event.clientY, dragged);
      if (to !== drag.to) setDrag({ ...drag, to });
    },
    onPointerUp: () => {
      if (!drag) return;
      setDrag(null);
      if (drag.to !== drag.from) onMove(drag.id, drag.to);
    },
    onPointerCancel: () => setDrag(null),
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
      if (to === null || to < 0 || to >= items.length) return;
      event.preventDefault();
      onMove(id, to);
    },
  });

  return { listRef, shown, dragging: drag?.id ?? null, grip };
}
