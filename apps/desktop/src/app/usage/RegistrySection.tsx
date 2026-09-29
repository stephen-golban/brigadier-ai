import { Reload } from "@openai/apps-sdk-ui/components/Icon";

import { useAction } from "@/app/conversation/useAction";
import { Button } from "@/components/ui/button";
import type { RegistryInfo } from "@/ipc/generated";
import { formatAgo, formatDateTime } from "@/lib/format";
import { checkRegistry } from "@/state/usage";

/** The model registry in use, where it came from, and "Check for updates". */
export function RegistrySection({ registry, now }: { registry: RegistryInfo; now: number }) {
  const check = useAction();
  const rows: Array<[string, string]> = [
    ["Revision", `${registry.revision} · ${registry.updated}`],
    [
      "Source",
      registry.source === "bundled" ? "Bundled with this version of Brigadier" : "Downloaded from the repository",
    ],
    ["Models", String(registry.models)],
  ];
  if (registry.fetchedAtMs !== null) rows.push(["Downloaded", formatDateTime(registry.fetchedAtMs)]);
  rows.push([
    "Last checked",
    registry.checkedAtMs !== null ? formatAgo(registry.checkedAtMs, now) : "Not yet",
  ]);
  return (
    <section aria-labelledby="usage-registry" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id="usage-registry" className="min-w-0 flex-1 text-sm font-medium">
          Model registry
        </h2>
        <Button
          size="xs"
          variant="outline"
          disabled={check.busy}
          onClick={() => check.run(checkRegistry)}
        >
          <Reload className={check.busy ? "animate-spin motion-reduce:animate-none" : undefined} />
          Check for updates
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {registry.error && (
        <p role="alert" className="text-warning text-xs">
          The last check didn't update it: {registry.error}
        </p>
      )}
      {check.error && (
        <p role="alert" className="text-destructive text-xs">
          {check.error}
        </p>
      )}
    </section>
  );
}
