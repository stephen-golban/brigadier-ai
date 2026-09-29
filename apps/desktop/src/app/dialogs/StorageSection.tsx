import { useEffect, useState } from "react";

import { errorText } from "@/app/dialogs/fields";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { openStorage, scanStorage } from "@/state/storage";

/**
 * Settings → Storage: how much Brigadier takes and how much of it can be cleaned, and the way
 * into the Storage dialog (where Uninstall Brigadier… is too).
 */
export function StorageSection({ onOpenStorage }: { onOpenStorage: () => void }) {
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    scanStorage().then(
      (report) =>
        current &&
        setSummary(
          report.cleanableBytes > 0
            ? `Brigadier uses ${formatBytes(report.totalBytes)} · ${formatBytes(report.cleanableBytes)} can be cleaned`
            : `Brigadier uses ${formatBytes(report.totalBytes)} · nothing to clean`,
        ),
      (cause: unknown) => current && setSummary(`Couldn't measure: ${errorText(cause)}`),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <section aria-labelledby="settings-storage" className="grid gap-1.5">
      <h3 id="settings-storage" className="text-muted-foreground text-xs">
        Storage
      </h3>
      <div className="flex items-center gap-3">
        <p className="text-sm flex-1">{summary ?? "Measuring…"}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onOpenStorage();
            openStorage();
          }}
        >
          Manage storage…
        </Button>
      </div>
    </section>
  );
}
