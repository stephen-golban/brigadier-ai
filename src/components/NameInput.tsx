import { forwardRef, type ComponentProps } from "react";
import { filterName } from "../name";
import { Input } from "./controls/input";

// Some macOS text events contain these control codes instead of moving the caret.
const arrows: Record<string, string> = {
  "\u001c": "ArrowLeft",
  "\u001d": "ArrowRight",
  "\u001e": "ArrowUp",
  "\u001f": "ArrowDown",
};

function moveCaret(
  input: HTMLInputElement,
  key: string,
  shift = false,
  word = false,
  edge = false,
) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  const backward = input.selectionDirection === "backward";
  const anchor = backward ? end : start;
  let caret = backward ? start : end;
  const left = key === "ArrowLeft";
  if (key === "Home" || key === "ArrowUp" || (edge && left)) caret = 0;
  else if (key === "End" || key === "ArrowDown" || edge)
    caret = input.value.length;
  else if (!shift && start !== end && !word) caret = left ? start : end;
  else if (word) {
    caret = left
      ? Math.max(0, input.value.slice(0, caret).search(/[^ ]+ *$/))
      : caret + (input.value.slice(caret).match(/^ *[^ ]+ */)?.[0].length ?? 0);
  } else caret += left ? -1 : 1;
  caret = Math.max(0, Math.min(input.value.length, caret));
  input.setSelectionRange(
    shift ? Math.min(anchor, caret) : caret,
    shift ? Math.max(anchor, caret) : caret,
    shift && caret < anchor ? "backward" : "forward",
  );
}

type Props = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "onKeyDown" | "type"
> & {
  value: string;
  onValueChange: (name: string) => void;
};

export const NameInput = forwardRef<HTMLInputElement, Props>(function NameInput(
  { value, onValueChange, ...props },
  ref,
) {
  return (
    <Input
      {...props}
      ref={ref}
      type="text"
      autoComplete="given-name"
      autoCapitalize="words"
      spellCheck={false}
      maxLength={200}
      value={filterName(value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const key = arrows[event.key] ?? event.key;
        if (
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(key)
        )
          return;
        event.preventDefault();
        moveCaret(
          event.currentTarget,
          key,
          event.shiftKey,
          event.altKey || event.ctrlKey,
          event.metaKey,
        );
      }}
      onChange={(event) => {
        const input = event.currentTarget;
        const raw = input.value;
        const start = filterName(
          raw.slice(0, input.selectionStart ?? raw.length),
        ).length;
        const end = filterName(
          raw.slice(0, input.selectionEnd ?? raw.length),
        ).length;
        const direction = input.selectionDirection ?? "none";
        const clean = filterName(raw);
        if (raw !== clean) {
          // Restore the caret as well as the value when typing/pasting is filtered.
          input.value = clean;
          input.setSelectionRange(start, end, direction);
          const native = event.nativeEvent as InputEvent;
          const arrow =
            native.inputType === "insertText" && native.data
              ? arrows[native.data]
              : undefined;
          if (arrow) moveCaret(input, arrow);
        }
        onValueChange(clean);
      }}
    />
  );
});
