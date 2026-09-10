/**
 * The app's one select-style menu, on Base UI's `Combobox` through the vendored kit wrapper
 * (`src/components/ui/combobox.tsx`).
 *
 * Until 2026-09-11 this was a `Popover` holding a hand-rolled `ListBox` of `Button`s plus a
 * `type="search"` `Input`; filtering, the empty state and the Enter/ArrowDown hand-off between
 * the filter and the list were all written here. `docs/research/assistant-ui-composer.md`
 * (recommendation C) replaces that with the kit's Combobox: filtering, highlight, typeahead,
 * focus return and collision-aware positioning are Base UI's.
 *
 * Two facts about the shape, both measured in `SelectMenu.test.tsx`:
 *
 *  - The **trigger** carries `role="combobox"`, not `role="button"`. Base UI gives the trigger the
 *    combobox role whenever the `Combobox.Input` lives inside the popup — which is this layout, and
 *    is also the default when there is no input at all
 *    (`@base-ui/react/combobox/root/AriaCombobox.js:975`, `combobox/trigger/ComboboxTrigger.js:142`).
 *    So `aria-label` on the trigger is what names the whole control.
 *  - The **filter is not a `searchbox`**. `Combobox.Input` sets no `type="search"`; Base UI gives
 *    it `role="combobox"` of its own, so while the popup is open there are two comboboxes in the
 *    tree — the trigger named `label`, the filter named "Search <label>". The old
 *    `getByRole("searchbox", …)` query has no successor.
 *
 * `MenuOption` gains `group` and `badge` from assistant-ui Elements' `ModelOption`
 * (`docs/research/assistant-ui-composer.md`, "Model picker API"); `description` was already the
 * same field. Nothing in `ModelInfo` (`src/wire.ts:245`) carries a provider today, so no call site
 * groups yet — `group` is here so the model list can, without another rebuild.
 */
import { useMemo } from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronDown } from "../icons";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { labelledButtonIcons } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { Description, Label } from "./controls/overlay";

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  /** A short trailing chip — Elements' `ModelOption` badge lane. */
  badge?: string;
  /** Heading this option sits under. Options with no group are listed first, ungrouped. */
  group?: string;
  disabled?: boolean;
  warning?: boolean;
}

/** What `Combobox`'s `items` wants for a grouped list: a heading plus its options. */
interface OptionGroup {
  value: string;
  items: MenuOption[];
}

/**
 * The same surface `controls/overlay.tsx` gives every other popover, minus its `overflow-auto`:
 * the kit's `ComboboxList` owns the scroll here.
 */
const surface =
  "overlay-surface max-h-[80dvh] w-auto min-w-(--anchor-width) max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-hairline bg-elevated p-1 text-text ring-0 shadow-overlay";

/** `"bottom start"` and friends, in Base UI's two props. Mirrors `controls/overlay.tsx`'s `place`. */
function place(placement: string) {
  const [side, align] = placement.split(" ");
  return {
    side: (["top", "bottom", "left", "right"].includes(side ?? "")
      ? side
      : "bottom") as "top" | "bottom" | "left" | "right",
    align: (align === "end" || align === "bottom"
      ? "end"
      : align === "center"
        ? "center"
        : "start") as "start" | "center" | "end",
  };
}

/** Label, value and description, case-insensitively. The pre-port filter matched label and value
 * only; the description was added with the combobox, which shows it in the row. */
function matches(option: MenuOption, query: string) {
  return `${option.label} ${option.value} ${option.description ?? ""}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

function Row({ option }: { option: MenuOption }) {
  return (
    <ComboboxItem
      value={option.value}
      disabled={option.disabled}
      className="min-h-8 flex-wrap"
    >
      <Label className={option.warning ? "text-warn" : undefined}>
        {option.label}
      </Label>
      {option.badge && (
        <span className="ms-auto text-xs text-text-secondary">
          {option.badge}
        </span>
      )}
      {option.description && (
        <Description className="w-full">{option.description}</Description>
      )}
    </ComboboxItem>
  );
}

export function SelectMenu({
  label,
  value,
  options,
  onChange,
  disabled = false,
  searchable = false,
  placement = "bottom start",
}: {
  label: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  searchable?: boolean;
  placement?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const grouped = options.some((option) => option.group);
  const items = useMemo<MenuOption[] | OptionGroup[]>(() => {
    if (!grouped) return options;
    const order: string[] = [];
    const byGroup = new Map<string, MenuOption[]>();
    for (const option of options) {
      const key = option.group ?? "";
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        order.push(key);
      }
      byGroup.get(key)!.push(option);
    }
    return order.map((key) => ({ value: key, items: byGroup.get(key)! }));
  }, [grouped, options]);
  const { side, align } = place(placement);
  const search = `Search ${label.toLowerCase()}`;
  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
      // `null` turns Base UI's own filtering off, which is what a menu with no filter field wants:
      // its options stay static however the (unrendered) query moves.
      filter={searchable ? matches : null}
      // Keeps the pre-port contract that Enter in the filter takes the first remaining option
      // (`a4e46eb:src/components/SelectMenu.tsx:73-77`). Base UI highlights nothing by default,
      // so Enter on a freshly typed query would otherwise do nothing. It only fires while
      // filtering, so an untouched popup still opens with no row highlighted.
      autoHighlight={searchable}
      itemToStringLabel={(item) =>
        options.find((option) => option.value === item)?.label ?? String(item)
      }
    >
      <ComboboxPrimitive.Trigger
        // The kit's own `ComboboxTrigger` is the 24px chevron box that sits *inside* a
        // `ComboboxInput`; this control's trigger is the composer pill, so it renders through
        // the kit `Button` at the adapter's old defaults — the same button and the same
        // `composer-select` class the pre-port trigger used.
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(labelledButtonIcons, "composer-select")}
          />
        }
        aria-label={label}
      >
        <span className={selected?.warning ? "text-warn" : undefined}>
          {selected?.label ?? value}
        </span>
        <ChevronDown className="size-4" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent
        side={side}
        align={align}
        // Both settings are `controls/overlay.tsx`'s, for the reason recorded there: one
        // `collisionBoundary` for both axes flips a composer popover sideways across the text
        // area, so the boundary stays the window and the perpendicular fallback stays off.
        collisionPadding={8}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        className={surface}
      >
        {searchable && (
          <ComboboxInput
            showTrigger={false}
            aria-label={search}
            placeholder={search}
            className="mb-1"
          />
        )}
        <ComboboxList>
          {grouped
            ? (group: OptionGroup) => (
                <ComboboxGroup key={group.value} items={group.items}>
                  {group.value && <ComboboxLabel>{group.value}</ComboboxLabel>}
                  <ComboboxCollection>
                    {(option: MenuOption) => (
                      <Row key={option.value} option={option} />
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )
            : (option: MenuOption) => (
                <Row key={option.value} option={option} />
              )}
        </ComboboxList>
        <ComboboxEmpty>No matching options</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
