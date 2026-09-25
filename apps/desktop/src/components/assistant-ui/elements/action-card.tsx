import { ArrowRight, Pencil, X } from "@openai/apps-sdk-ui/components/Icon";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/*
 * ChatGPT's action cards, which take the composer's place while a decision waits: an
 * approval ("Terminal", the justification, the command, Deny / Allow once), a question
 * (numbered answers, the free-text row, Skip) and "Implement this plan?". One shell, same
 * width and radius as the composer card.
 */

/** The card itself; its content decides the keys (Esc, digits) through `onKeyDown`. */
export function ActionCard({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="action-card"
      className={cn(
        "bg-composer rounded-composer shadow-hairline border-foreground/10 animate-in fade-in flex w-full flex-col gap-2.5 border p-3 outline-none duration-150",
        className,
      )}
      {...props}
    />
  );
}

/** "▣ Terminal": what kind of decision, small and dim. */
export function ActionCardKind({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 px-1 text-sm [&_svg]:size-icon-md [&_svg]:shrink-0">
      {icon}
      {children}
    </p>
  );
}

/** The question the card asks, with an optional × that puts it aside. */
export function ActionCardTitle({
  children,
  detail,
  onDismiss,
}: {
  children: ReactNode;
  detail?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 px-1">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-base font-medium">{children}</h2>
        {detail && <p className="text-muted-foreground text-sm">{detail}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground rounded-capsule size-icon-button-sm flex shrink-0 items-center justify-center transition-colors [&_svg]:size-icon-sm"
        >
          <X />
        </button>
      )}
    </div>
  );
}

/** Exact text the card asks about (a command line, paths), three lines until expanded. */
export function ActionCardCode({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setClamped(element.scrollHeight > element.clientHeight + 1),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="bg-foreground/5 rounded-control flex flex-col">
      <pre
        ref={ref}
        data-selectable
        className={cn(
          "text-muted-foreground px-2.5 py-2 font-mono text-xs whitespace-pre-wrap",
          expanded ? "max-h-60 overflow-auto" : "line-clamp-3",
        )}
      >
        {children}
      </pre>
      {(clamped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground self-start px-2.5 pb-1.5 text-xs transition-colors"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

/** A numbered answer: its disc, label, "Recommended", a description, → while highlighted. */
export function ActionOption({
  number,
  label,
  description,
  recommended,
  highlighted,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  number: number;
  label: ReactNode;
  description?: ReactNode;
  recommended?: boolean;
  highlighted: boolean;
}) {
  return (
    <button
      type="button"
      data-slot="action-option"
      data-highlighted={highlighted || undefined}
      className="data-highlighted:bg-foreground/5 rounded-xl flex w-full items-center gap-3 px-2 py-1.5 text-start outline-none transition-colors"
      {...props}
    >
      <span className="border-foreground/15 text-muted-foreground rounded-capsule size-icon-button-md flex shrink-0 items-center justify-center border text-xs tabular-nums">
        {number}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          {label}
          {recommended && <Badge variant="secondary">Recommended</Badge>}
        </span>
        {description && <span className="text-muted-foreground text-sm">{description}</span>}
      </span>
      <ArrowRight
        aria-hidden
        className={cn("text-muted-foreground size-icon-md shrink-0", !highlighted && "invisible")}
      />
    </button>
  );
}

/** The last row: ✎ and "No, and tell Brigadier what to do differently", then its actions. */
export function ActionFreeText({
  children,
  ...props
}: ComponentProps<"input"> & { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-2">
      <span className="border-foreground/15 text-muted-foreground rounded-capsule size-icon-button-md flex shrink-0 items-center justify-center border [&_svg]:size-icon-xs">
        <Pencil />
      </span>
      <input
        className="placeholder:text-muted-foreground min-h-control-md min-w-0 flex-1 bg-transparent text-sm outline-none"
        {...props}
      />
      {children}
    </div>
  );
}
