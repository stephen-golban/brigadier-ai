/**
 * The Model and Permissions controls, drawn once and used by both dock modes that need them.
 *
 * R4, 2026-09-05. They existed only on **Session**, so the owner picked "Haiku 4.5" in the dock,
 * pressed Start on a **run**, and watched the session header say `claude-opus-5[1m]`: the pickers
 * reached nothing, because `start_run` took only a project and a goal. It takes a model and a
 * permission mode now, and Run draws the same two controls Session always had — the same markup,
 * so the two menus cannot drift into offering different vocabularies for the same wire field.
 *
 * Two things differ between the modes and both are props rather than branches in here:
 *
 *   - **"No pick" is offered where it is a real answer**, which is the run. `null` for a model is
 *     not an empty field: it means the harness's role-based routing stays in charge, so a
 *     judgement call takes the provider's strong default and a work order takes its per-order
 *     tier. `noPickLabel` is what says so; where it is null, the menu has no empty entry and the
 *     parent pre-selects a real model, which is what starting a single session has always done.
 *   - **The permission-mode list is not a prop.** It is `OFFERED_PERMISSION_MODES` in
 *     `src/wire.ts` and it is the whole set the CLI accepts, `bypass-permissions` included. See
 *     that constant for why leaving it out was a gate on a value that changed nothing.
 */
import { SelectMenu } from "./SelectMenu";
import { OFFERED_PERMISSION_MODES } from "../wire";
import type { ModelInfo, PermissionMode } from "../wire";

export interface PickersProps {
  models: ModelInfo[];
  provider?: string;
  /** The selected model id. `""` is "no pick", and is only reachable when `noPickLabel` is set. */
  model: string;
  onModel: (id: string) => void;
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
  disabled: boolean;
  /**
   * Text for the empty-value option, or `null` to leave it out entirely. Never a bare "" — an
   * unlabelled empty option reads as a field that failed to load rather than as a choice.
   */
  noPickLabel: string | null;
  /** The `title` on the model control, saying what a no-pick actually does. */
  modelHint?: string;
}

export function Pickers({
  models,
  provider,
  model,
  onModel,
  mode,
  onMode,
  disabled,
  noPickLabel,
  modelHint,
}: PickersProps) {
  return (
    <>
      <SelectMenu
        label="Permissions"
        value={mode}
        onChange={(value) => onMode(value as PermissionMode)}
        disabled={disabled}
        options={OFFERED_PERMISSION_MODES.filter(m=>provider!=="codex" || m.mode!=="auto").map((m) => ({
          value: m.mode,
          label: m.label.split(" — ")[0]!,
          description: m.note,
          warning: m.mode === "bypass-permissions" || m.mode === "dont-ask",
        }))}
      />
      <SelectMenu
        label="Model"
        value={model}
        onChange={onModel}
        disabled={disabled}
        searchable
        options={[
          ...(noPickLabel === null
            ? []
            : [{ value: "", label: noPickLabel, description: modelHint }]),
          ...models.map((m) => ({
            value: m.id,
            label: m.label.split(" — ")[0]!,
            description: m.id,
          })),
        ]}
      />
    </>
  );
}
