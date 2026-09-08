import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./command";
export interface SearchGroup {
  label: string;
  items: {
    id: string;
    search: string;
    content: ReactNode;
    onSelect: () => void;
  }[];
}
export function SearchDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: SearchGroup[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(null);
    }
  }, [open]);
  const id = useId();
  const shown = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        query
          .toLowerCase()
          .trim()
          .split(/\s+/)
          .every((word) => item.search.toLowerCase().includes(word)),
      ),
    }))
    .filter((group) => group.items.length);
  const items = shown.flatMap((group) => group.items);
  const selected = items.find((item) => item.id === active) ?? items[0];
  const optionId = (itemId: string) => `${id}-${itemId}`;
  const select = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    setActive(item.id);
    document
      .getElementById(optionId(item.id))
      ?.scrollIntoView?.({ block: "nearest" });
  };
  return (
    <CommandDialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) {
          setQuery("");
          setActive(null);
        }
      }}
    >
      <Command>
        <CommandInput
          autoFocus
          role="combobox"
          aria-label="Search"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={selected ? optionId(selected.id) : undefined}
          value={query}
          placeholder="Type a command or search..."
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const index = items.findIndex((item) => item.id === selected?.id);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              select(
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : index + (event.key === "ArrowDown" ? 1 : -1),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              selected?.onSelect();
            }
          }}
        />
        <CommandList ref={list} id={`${id}-list`} aria-label="Search results">
          {!items.length && <CommandEmpty>No results found.</CommandEmpty>}
          {shown.map((group, index) => (
            <Fragment key={group.label}>
              {index > 0 && <CommandSeparator />}
              <CommandGroup heading={group.label}>
                {group.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    id={optionId(item.id)}
                    aria-selected={selected?.id === item.id}
                    onPointerMove={() => setActive(item.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={item.onSelect}
                  >
                    {item.content}
                  </CommandItem>
                ))}
              </CommandGroup>
            </Fragment>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
