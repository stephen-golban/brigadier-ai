import { ChevronDown } from "@openai/apps-sdk-ui/components/Icon";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { useId, type ComponentProps, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/*
 * The parts every Settings page is built from: a page (title, optional description and actions,
 * then its sections), a section (a heading over its cards), a card (rows split by inset
 * hairlines), a row (label and description on the start, the control on the end) and the
 * controls rows use (switch, segmented choice, select, button).
 */

/** A Settings page: its title, then its sections in a centred column that scrolls. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-slot="settings-page" className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="max-w-settings mx-auto flex w-full flex-col px-5 pt-4 pb-12">
        <header className="flex items-start gap-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-page-title font-medium">{title}</h1>
            {description && <p className="text-muted-foreground text-sm">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        <div className="flex flex-col gap-10 pt-5">{children}</div>
      </div>
    </div>
  );
}

/** A heading over one or more cards (or any content), with optional actions at its end. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cn("flex flex-col", className)}>
      {(title || actions) && (
        <div className="flex min-h-11.5 items-center justify-between gap-4 pb-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title && (
              <h2 id={id} className="text-sm font-medium">
                {title}
              </h2>
            )}
            {description && <p className="text-muted-foreground text-label">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

/** A card of rows; every row but the last has a hairline under it, inset from the card's edges. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-slot="settings-card"
      className={cn(
        "bg-card border-divider rounded-settings flex flex-col overflow-hidden border",
        "*:not-last:relative *:not-last:after:pointer-events-none *:not-last:after:absolute *:not-last:after:inset-x-4 *:not-last:after:bottom-0 *:not-last:after:h-px *:not-last:after:bg-divider",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One setting: its label and description on the start, its control on the end. `htmlFor` ties
 * the label to a control with that id; without it, give the control its own label.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn("@container flex items-center justify-between gap-6 px-4 py-3", className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-label font-medium break-words">
            {label}
          </label>
        ) : (
          <div className="text-label font-medium break-words">{label}</div>
        )}
        {description && (
          <div className="text-muted-foreground text-xs break-words">{description}</div>
        )}
      </div>
      {children && (
        <div className="flex max-w-full min-w-settings-control shrink-0 items-center justify-end gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

/** A setting that is on or off. */
export function SettingsSwitch({
  label,
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  /** The accessible name, usually the row's label. */
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Switch
      id={id}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
    />
  );
}

export type Choice<T extends string> = { value: T; label: ReactNode; hint?: ReactNode };

/** One of a few choices as pills side by side; the chosen one is filled. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      aria-label={label}
      value={value}
      disabled={disabled ?? false}
      // A single choice is always made: pressing the chosen pill again keeps it.
      onValueChange={(next) => next && onChange(next as T)}
      className="flex max-w-full min-w-0 items-center gap-0.5"
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className="text-muted-foreground hover:text-foreground data-[state=on]:bg-foreground/5 data-[state=on]:text-foreground focus-visible:ring-ring/50 rounded-capsule text-label h-6 shrink-0 border border-transparent px-2 whitespace-nowrap transition-colors outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

/** One of several choices in a menu, shown as a button with the chosen one's label. */
export function SettingsSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
}: {
  label: string;
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  id?: string;
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          aria-label={label}
          className="border-divider bg-foreground/3 hover:bg-foreground/6 data-[state=open]:bg-foreground/6 focus-visible:ring-ring/50 rounded-nav text-label flex h-7 max-w-full min-w-0 items-center gap-1 border px-3 transition-colors outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{chosen?.label}</span>
          <ChevronDown aria-hidden className="text-muted-foreground size-icon-sm shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-sm">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className={option.hint ? "h-auto py-1.5" : undefined}
            >
              <span className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                {option.hint && (
                  <span className="text-muted-foreground text-xs whitespace-normal">{option.hint}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A row's action button; `destructive` for an action that deletes or removes. */
export function SettingsButton({
  destructive,
  className,
  ...props
}: ComponentProps<typeof Button> & { destructive?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "rounded-nav bg-foreground/5 hover:bg-foreground/10 text-label font-normal",
        destructive && "text-destructive",
        className,
      )}
      {...props}
    />
  );
}
