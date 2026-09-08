import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./controls/button";

type Location = {
  projectId: string | null;
  sessionId: string | null;
  page?: "workspace" | "notepad";
};
const same = (a: Location | undefined, b: Location) =>
  a?.projectId === b.projectId &&
  a?.sessionId === b.sessionId &&
  a?.page === b.page;

/** Workspace navigation history, independent of conversation branching and browser history. */
export function NavigationHistoryControls({
  projectId,
  sessionId,
  page,
  beforeNavigate,
  onNavigate,
  isAvailable,
}: Location & {
  onNavigate: (location: Location) => void;
  beforeNavigate?: (next: () => void) => void;
  isAvailable: (location: Location) => boolean;
}) {
  const [history, setHistory] = useState<{
    entries: Location[];
    index: number;
  }>({ entries: [], index: -1 });
  useEffect(() => {
    if (!projectId && !sessionId && page !== "notepad") return;
    const current = { projectId, sessionId, ...(page ? { page } : {}) };
    setHistory((old) => {
      if (same(old.entries[old.index], current)) return old;
      const entries = [...old.entries.slice(0, old.index + 1), current].slice(
        -100,
      );
      return { entries, index: entries.length - 1 };
    });
  }, [projectId, sessionId, page]);
  const find = (direction: number) => {
    for (
      let i = history.index + direction;
      i >= 0 && i < history.entries.length;
      i += direction
    )
      if (isAvailable(history.entries[i])) return i;
    return -1;
  };
  const move = (index: number) => {
    if (index < 0) return;
    const commit = () => {
      setHistory((old) => ({ ...old, index }));
      onNavigate(history.entries[index]);
    };
    if (beforeNavigate) beforeNavigate(commit);
    else commit();
  };
  return (
    <>
      <Button
        isIconOnly
        aria-label="Go back"
        title="Go back"
        disabled={find(-1) < 0}
        onClick={() => move(find(-1))}
        className="size-7 rounded-md text-text-secondary hover:bg-transparent hover:text-text [&_svg]:text-current"
      >
        <ArrowLeft strokeWidth={1.5} />
      </Button>
      <Button
        isIconOnly
        aria-label="Go forward"
        title="Go forward"
        disabled={find(1) < 0}
        onClick={() => move(find(1))}
        className="size-7 rounded-md text-text-secondary hover:bg-transparent hover:text-text [&_svg]:text-current"
      >
        <ArrowRight strokeWidth={1.5} />
      </Button>
    </>
  );
}
