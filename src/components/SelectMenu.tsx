import { useEffect, useId, useRef, useState } from "react";
import {
  CaretDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
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
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const shown = options.filter((o) =>
    `${o.label} ${o.value}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (!open) return;
    const click = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", click);
    return () => document.removeEventListener("pointerdown", click);
  }, [open]);
  const choose = (option: MenuOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="select-menu"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          setFocused(
            (f) =>
              (f + (e.key === "ArrowDown" ? 1 : -1) + shown.length) %
              Math.max(1, shown.length),
          );
        }
        if (open && e.key === "Enter") {
          e.preventDefault();
          const option = shown[focused];
          if (option) choose(option);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="composer-select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setFocused(
            Math.max(
              0,
              options.findIndex((o) => o.value === value),
            ),
          );
        }}
      >
        {options.find((o) => o.value === value)?.label ?? value}
        <CaretDownIcon size={11} />
      </button>
      {open ? (
        <div className="select-popover" id={id}>
          {searchable ? (
            <label className="menu-search">
              <MagnifyingGlassIcon size={16} />
              <input
                autoFocus
                aria-label={`Search ${label.toLowerCase()}`}
                placeholder={`Search ${label.toLowerCase()}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFocused(0);
                }}
              />
            </label>
          ) : null}
          <div role="listbox" aria-label={label}>
            {shown.map((option, index) => (
              <button
                type="button"
                key={option.value}
                role="option"
                value={option.value}
                aria-selected={value === option.value}
                aria-disabled={option.disabled}
                className={focused === index ? "focused" : ""}
                onMouseEnter={() => setFocused(index)}
                onClick={() => choose(option)}
              >
                <span>
                  <span>{option.label}</span>
                  {option.description ? (
                    <small>{option.description}</small>
                  ) : null}
                </span>
                {value === option.value ? <CheckIcon size={16} /> : null}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="panel-empty">No matching options</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
