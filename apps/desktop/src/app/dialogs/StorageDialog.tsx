import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CheckboxRow, ErrorLine, errorText } from "@/app/dialogs/fields";
import { Spinner } from "@/components/glyphs/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { revealPath } from "@/ipc/client";
import type {
  CleanCategory,
  CleanItem,
  CleanReport,
  SharedPart,
  StorageReport,
} from "@/ipc/generated";
import { formatBytes } from "@/lib/format";
import {
  cleanStorage,
  closeStorageDialogs,
  openUninstall,
  scanStorage,
  useStorageUi,
} from "@/state/storage";
import { useApp } from "@/state/store";

const CATEGORIES: readonly { category: CleanCategory; title: string }[] = [
  { category: "worktrees", title: "Worktrees" },
  { category: "branches", title: "Branches" },
  { category: "sessionFiles", title: "Leftover session files" },
  { category: "brains", title: "Brains and code indexes" },
  { category: "logsAndData", title: "Logs, recordings and stored files" },
  { category: "models", title: "Downloaded models" },
  { category: "processes", title: "Other Brigadier daemons and connections" },
  { category: "database", title: "Database" },
];

const SHARED: Record<SharedPart, string> = {
  database: "Database",
  otherBlobs: "Other stored files",
  models: "Downloaded models",
  logs: "Logs",
  recordings: "Recordings",
  personalBrain: "Personal Brain",
  other: "Everything else",
};

/**
 * Settings → Storage → Manage storage…: what Brigadier takes per project and for what every
 * project shares, and what it can clean up, scoped strictly to what it created. Safe items come
 * checked; the ones that cost something to lose come unchecked. Cleaning ends on what it gave
 * back and what it couldn't remove.
 */
export function StorageDialog() {
  const open = useStorageUi((s) => s.storageOpen);
  // A new scan starts the flow afresh.
  const [scans, setScans] = useState(0);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeStorageDialogs()}>
      <DialogContent className="max-w-2xl max-h-full overflow-y-auto">
        {open && <StorageFlow key={scans} onScanAgain={() => setScans((n) => n + 1)} />}
      </DialogContent>
    </Dialog>
  );
}

type Phase =
  | { type: "scanning" }
  | { type: "report"; report: StorageReport }
  | { type: "cleaning"; report: StorageReport }
  | { type: "done"; report: StorageReport; cleaned: CleanReport };

function StorageFlow({ onScanAgain }: { onScanAgain: () => void }) {
  const [phase, setPhase] = useState<Phase>({ type: "scanning" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    scanStorage().then(
      (report) => current && setPhase({ type: "report", report }),
      (cause: unknown) => current && setError(errorText(cause)),
    );
    return () => {
      current = false;
    };
  }, []);

  const clean = (report: StorageReport, items: string[]) => {
    setPhase({ type: "cleaning", report });
    setError(null);
    cleanStorage(report.scanId, items).then(
      (cleaned) => setPhase({ type: "done", report, cleaned }),
      (cause: unknown) => {
        setError(errorText(cause));
        setPhase({ type: "report", report });
      },
    );
  };

  if (phase.type === "done") {
    return <Done cleaned={phase.cleaned} onScanAgain={onScanAgain} />;
  }
  if (phase.type === "scanning") {
    return (
      <div className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Storage</DialogTitle>
          <DialogDescription>Looking at what Brigadier keeps on this computer…</DialogDescription>
        </DialogHeader>
        {!error && <Spinner className="size-icon-sm animate-spin" />}
        <ErrorLine error={error} />
        <Footer />
      </div>
    );
  }
  return (
    <Report
      report={phase.report}
      cleaning={phase.type === "cleaning"}
      error={error}
      onClean={(items) => clean(phase.report, items)}
    />
  );
}

function Footer({ children }: { children?: ReactNode }) {
  return (
    <DialogFooter>
      <Button type="button" variant="ghost" className="me-auto" onClick={openUninstall}>
        Uninstall Brigadier…
      </Button>
      {children ?? (
        <Button type="button" variant="ghost" onClick={closeStorageDialogs}>
          Close
        </Button>
      )}
    </DialogFooter>
  );
}

function Report({
  report,
  cleaning,
  error,
  onClean,
}: {
  report: StorageReport;
  cleaning: boolean;
  error: string | null;
  onClean: (items: string[]) => void;
}) {
  const [picked, setPicked] = useState(
    () => new Set(report.items.filter((i) => i.checked && i.selectable).map((i) => i.id)),
  );
  const chosen = report.items.filter((item) => picked.has(item.id));
  const chosenBytes = chosen.reduce((sum, item) => sum + item.bytes, 0);
  const groups = useMemo(
    () =>
      CATEGORIES.map(({ category, title }) => ({
        title,
        items: report.items.filter((item) => item.category === category),
      })).filter((group) => group.items.length > 0),
    [report.items],
  );

  const pick = (id: string, on: boolean) =>
    setPicked((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Storage</DialogTitle>
        <DialogDescription>
          Brigadier uses {formatBytes(report.totalBytes)} in{" "}
          <span className="text-foreground break-all">{report.dataDir}</span>. Only what
          Brigadier created is listed here; your own files and branches are never touched.
        </DialogDescription>
      </DialogHeader>

      <Usage report={report} />

      <section aria-labelledby="storage-cleanable" className="grid gap-3">
        <h3 id="storage-cleanable" className="text-muted-foreground text-xs">
          What can be cleaned up
        </h3>
        {groups.length === 0 && (
          <p className="text-muted-foreground text-sm">Nothing: Brigadier is tidy.</p>
        )}
        {groups.map((group) => (
          <div key={group.title} className="grid gap-2">
            <h4 className="text-sm font-medium">{group.title}</h4>
            {group.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                checked={picked.has(item.id)}
                onCheckedChange={(on) => pick(item.id, on)}
              />
            ))}
          </div>
        ))}
      </section>

      <ErrorLine error={error} />
      <Footer>
        <Button type="button" variant="ghost" onClick={closeStorageDialogs}>
          Close
        </Button>
        <Button
          type="button"
          disabled={cleaning || chosen.length === 0}
          onClick={() => onClean(chosen.map((item) => item.id))}
        >
          {cleaning
            ? "Cleaning…"
            : chosen.length === 0
              ? "Clean"
              : `Clean ${chosen.length} ${chosen.length === 1 ? "item" : "items"} (${formatBytes(chosenBytes)})`}
        </Button>
      </Footer>
    </div>
  );
}

/** Disk use per project and for what every project shares. */
function Usage({ report }: { report: StorageReport }) {
  const cell = "py-1 ps-3 text-end tabular-nums";
  return (
    <section aria-labelledby="storage-usage" className="grid gap-1.5">
      <h3 id="storage-usage" className="text-muted-foreground text-xs">
        Disk use
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-border border-b">
              <th className="py-1 text-start font-normal">Project</th>
              <th className={`${cell} font-normal`}>Worktrees</th>
              <th className={`${cell} font-normal`}>Brain + index</th>
              <th className={`${cell} font-normal`}>Conversations</th>
              <th className={`${cell} font-normal`}>Scratch</th>
              <th className={`${cell} font-normal`}>Total</th>
            </tr>
          </thead>
          <tbody>
            {report.projects.map((project) => (
              <tr key={project.projectId} className="border-border border-b">
                <td className="py-1">
                  {project.name}
                  {!project.repoFound && (
                    <span className="text-muted-foreground"> · repository not found</span>
                  )}
                </td>
                <td className={cell}>{formatBytes(project.worktreesBytes)}</td>
                <td className={cell}>{formatBytes(project.brainBytes)}</td>
                <td className={cell}>{formatBytes(project.blobsBytes)}</td>
                <td className={cell}>{formatBytes(project.scratchBytes)}</td>
                <td className={cell}>
                  {formatBytes(
                    project.worktreesBytes +
                      project.brainBytes +
                      project.blobsBytes +
                      project.scratchBytes,
                  )}
                </td>
              </tr>
            ))}
            {report.shared.map((shared) => (
              <tr key={shared.part} className="border-border border-b last:border-b-0">
                <td className="text-muted-foreground py-1" colSpan={5}>
                  {SHARED[shared.part]}
                </td>
                <td className={cell}>{formatBytes(shared.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ItemRow({
  item,
  checked,
  onCheckedChange,
}: {
  item: CleanItem;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const mac = useApp((s) => s.info?.platform === "macos");
  const path = item.path;
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <CheckboxRow
          label={item.label}
          checked={checked && item.selectable}
          disabled={!item.selectable}
          onCheckedChange={onCheckedChange}
          note={
            <>
              {item.badges.map((badge) => (
                <Badge key={badge.type} variant="warning" className="me-1.5">
                  {badge.type === "hasChanges"
                    ? "Has changes"
                    : badge.type === "notMerged"
                      ? `Not merged · ${badge.ahead} ahead`
                      : "Older Brigadier"}
                </Badge>
              ))}
              {item.reason}
              {item.toTrash && " Goes to the Trash."}
            </>
          }
        />
      </div>
      <span className="text-muted-foreground shrink-0 pt-0.5 text-xs tabular-nums">
        {formatBytes(item.bytes)}
      </span>
      {path && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => void revealPath(path).catch(() => {})}
        >
          {mac ? "Reveal in Finder" : "Open in File Manager"}
        </Button>
      )}
    </div>
  );
}

function countItems(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function Done({ cleaned, onScanAgain }: { cleaned: CleanReport; onScanAgain: () => void }) {
  const failed = cleaned.failures.length;
  const picked = cleaned.removed + failed;
  // An item that failed may still have given some space back (only part of it went).
  const title =
    failed === 0
      ? `Cleaned ${countItems(cleaned.removed)}`
      : cleaned.removed > 0
        ? `Cleaned ${cleaned.removed} of ${countItems(picked)}`
        : cleaned.reclaimedBytes + cleaned.trashedBytes > 0
          ? `Cleaned part of ${picked === 1 ? "the item" : `the ${picked} items`}`
          : picked === 1
            ? "The item couldn't be cleaned"
            : "None of the items could be cleaned";
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {cleaned.removed === 0 && cleaned.reclaimedBytes + cleaned.trashedBytes === 0 ? (
            "Nothing was removed."
          ) : (
            <>
              {formatBytes(cleaned.reclaimedBytes)} freed now.
              {cleaned.trashedBytes > 0 &&
                ` ${formatBytes(cleaned.trashedBytes)} moved to the Trash: empty it to get that space back.`}
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      {cleaned.failures.length > 0 && (
        <section aria-labelledby="storage-failures" className="grid gap-1.5">
          <h3 id="storage-failures" className="text-muted-foreground text-xs">
            Not removed
          </h3>
          <ul className="grid gap-1.5 text-sm">
            {cleaned.failures.map((failure, index) => (
              <li key={index} className="grid gap-0.5">
                <span>{failure.label}</span>
                <span className="text-destructive text-xs break-all">{failure.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Footer>
        <Button type="button" variant="ghost" onClick={onScanAgain}>
          Scan again
        </Button>
        <Button type="button" onClick={closeStorageDialogs}>
          Done
        </Button>
      </Footer>
    </div>
  );
}
