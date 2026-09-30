import { ChevronDown } from "@openai/apps-sdk-ui/components/Icon";
import { useState } from "react";

import { CategoryCard } from "@/app/routing/CategoryCard";
import { RulesSection } from "@/app/routing/RulesSection";
import {
  type Choice,
  SettingsButton,
  SettingsPage,
  SettingsSection,
  SettingsSelect,
} from "@/app/settings/parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Area } from "@/ipc/generated";
import { AREA_LABELS, AREAS, RANKED_CATEGORIES } from "@/lib/routing";
import { useModelGroups } from "@/lib/setup";
import { resetToAutomatic, useRoutePreview } from "@/state/routing";
import { useApp } from "@/state/store";

/**
 * The Routing page: per kind of work, whether Brigadier ranks the models (Automatic, with the
 * live order and why) or tries the user's list (Manual), everywhere or in one project, with
 * area overrides; then the user's rules.
 */
export function RoutingPage() {
  const groups = useModelGroups();
  const projects = useApp((s) => s.projects);
  const rankings = useApp((s) => s.settings.routingRankings);
  const [scope, setScope] = useState<string | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [resetting, setResetting] = useState(false);
  const { routes, error } = useRoutePreview(scope, areas);

  const scopes: Choice<string>[] = [
    { value: "", label: "Everywhere" },
    ...Object.values(projects)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ value: project.id, label: `In ${project.name}` })),
  ];
  const manualHere = rankings.some((ranking) => ranking.projectId === scope && ranking.manual);

  return (
    <SettingsPage
      title="Routing"
      description="How Brigadier picks a model and effort for each kind of work. Automatic ranks models by strength, what worked in the project and quota; Manual tries your list top-down."
      actions={
        <>
          <SettingsSelect
            label="Where these settings apply"
            value={scope ?? ""}
            options={scopes}
            onChange={(value) => setScope(value === "" ? null : value)}
          />
          <SettingsButton disabled={!manualHere} onClick={() => setResetting(true)}>
            Reset to automatic
          </SettingsButton>
        </>
      }
    >
      <SettingsSection
        title="Kinds of work"
        description="What the next task of each kind would run on, now. The orchestrator's own model is picked in the composer."
        actions={<AreaPicker areas={areas} onChange={setAreas} />}
      >
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {RANKED_CATEGORIES.map((category) => (
          <CategoryCard
            key={category}
            category={category}
            route={routes?.find((route) => route.category === category) ?? null}
            scope={scope}
            groups={groups}
          />
        ))}
      </SettingsSection>
      <RulesSection groups={groups} />
      <p className="text-muted-foreground text-xs">
        Brigadier's own rules hold whatever you choose: no Fable models, effort at most high, a
        model at its limit waits until it resets, and a change is reviewed by another vendor when
        one can.
      </p>
      <ResetDialog
        open={resetting}
        scope={scope ? (projects[scope]?.name ?? "this project") : null}
        onOpenChange={setResetting}
        onConfirm={() => resetToAutomatic(scope)}
      />
    </SettingsPage>
  );
}

/** The areas the preview asks about ("a task touching frontend"). */
function AreaPicker({ areas, onChange }: { areas: Area[]; onChange: (areas: Area[]) => void }) {
  const label =
    areas.length === 0
      ? "Any area"
      : areas.map((area) => AREA_LABELS[area]).join(", ").replace(/^./, (first) => first.toUpperCase());
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant="ghost" aria-label={`Preview for tasks touching: ${label}`}>
          {label}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Preview for tasks touching</DropdownMenuLabel>
        {AREAS.map((area) => (
          <DropdownMenuCheckboxItem
            key={area}
            checked={areas.includes(area)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(checked ? [...areas, area] : areas.filter((other) => other !== area))
            }
          >
            {AREA_LABELS[area].charAt(0).toUpperCase()}
            {AREA_LABELS[area].slice(1)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ResetDialog({
  open,
  scope,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  /** The project's name; `null`: everywhere. */
  scope: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset {scope ? `${scope}'s routing` : "routing"} to automatic?</DialogTitle>
          <DialogDescription>
            Every kind of work and area override {scope ? `in ${scope}` : "everywhere"} goes back to
            Automatic. Your lists are kept, so switching a row to Manual brings its list back; your
            rules stay as they are.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void confirm()}>
            Reset to automatic
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
