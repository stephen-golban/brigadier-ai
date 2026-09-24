import { useCallback, useState } from "react";

/** Runs a daemon request from a button and keeps its error to show next to it. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: (action: () => Promise<unknown>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }, []);
  return { busy, error, run };
}
