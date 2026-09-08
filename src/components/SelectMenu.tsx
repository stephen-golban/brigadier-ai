import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Popover, Label, Description } from "./controls/overlay";
import { ListBox } from "./controls/listbox";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  warning?: boolean;
}
export function SelectMenu({
  label,
  value,
  options,
  onChange,
  disabled = false,
  searchable = false,
}: {
  label: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  searchable?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const shown = options.filter((option) =>
    `${option.label} ${option.value}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const select = (value: string) => {
    onChange(value);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover
      isOpen={open}
      onOpenChange={(open) => {
        setOpen(open);
        setQuery("");
      }}
    >
      <Button
        aria-label={label}
        disabled={disabled}
        className="composer-select"
      >
        <span className={selected?.warning ? "text-warn" : undefined}>
          {selected?.label ?? value}
        </span>
        <ChevronDownIcon className="size-4" />
      </Button>
      <Popover.Content>
        {searchable && (
          <Input
            type="search"
            autoFocus
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                const first = shown.find((option) => !option.disabled);
                if (first) select(first.value);
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget.parentElement
                  ?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
                  ?.focus();
              }
            }}
          />
        )}
        <ListBox
          aria-label={label}
          value={value}
          onValueChange={select}
          disabledKeys={options
            .filter((option) => option.disabled)
            .map((option) => option.value)}
          renderEmptyState={() => "No matching options"}
        >
          {shown.map((option) => (
            <ListBox.Item
              key={option.value}
              id={option.value}
              textValue={option.label}
            >
              <Label className={option.warning ? "text-warn" : undefined}>
                {option.label}
              </Label>
              {option.description && (
                <Description className="w-full">
                  {option.description}
                </Description>
              )}
            </ListBox.Item>
          ))}
        </ListBox>
      </Popover.Content>
    </Popover>
  );
}
