import { useId, type ComponentProps, type ReactNode } from "react";

import { Checkbox as KitCheckbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * Adapter over the kit's Base UI `Checkbox` (`src/components/ui/checkbox.tsx`) and `Field`.
 *
 * The 12 call sites pass their label as `children`; the kit's `Checkbox` renders `children` inside
 * the tick's `<Indicator>` slot instead. So this wrapper keeps the old signature and re-homes the
 * label: `<Field orientation="horizontal">` holds the control and a sibling `<FieldLabel htmlFor>`.
 *
 * What a consumer can no longer do: pass arbitrary `<input>` props. The kit's control is a
 * `<button role="checkbox">` plus a hidden input, not a bare `<input>`, so `onChange`, `type`,
 * `value` and the rest of `ComponentProps<"input">` are gone. Every current call site passes only
 * `checked`, `disabled`, `onCheckedChange`, `className` and `children`, which all survive:
 * Base UI hands `onCheckedChange` the boolean first, so the existing one-argument arrows are
 * unchanged (`docs/research/shadcn-base-ui.md`, "Checkbox API diff").
 *
 * `className` lands on the `<Field>` — the row — which is where the old `<label>` carried it.
 */
export function Checkbox({
  children,
  className,
  id,
  ...props
}: Omit<ComponentProps<typeof KitCheckbox>, "children"> & {
  children?: ReactNode;
}) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <Field
      orientation="horizontal"
      className={cn("w-fit gap-2 text-[13px]", className)}
    >
      <KitCheckbox id={controlId} {...props} />
      <FieldLabel htmlFor={controlId} className="font-normal">
        {children}
      </FieldLabel>
    </Field>
  );
}
