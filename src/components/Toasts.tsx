import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Archive, X } from "../icons";
import { notify, type ToastNotice } from "../desktopApi";
import { errorMessage } from "../workspaceApi";
import { Button } from "@/components/ui/button";
import { iconButtonXs } from "@/lib/surfaces";
import { cn } from "@/lib/utils";
import { Toaster } from "./ui/sonner";

/**
 * `leaving` is owned by the `Notice`, but sonner's timer fires outside it. Each mounted notice
 * registers its setter here so the toast's `onAutoClose` / `onDismiss` can flip the same flag: a
 * notice that expires on its own 6s timer would otherwise keep `role="status"` through the whole
 * 200ms exit, which is the state `App.test.tsx:671` exists to keep out of the tree.
 */
const leavingSetters = new Map<string, () => void>();

/**
 * The notice row. Sonner owns the portal, the stack, the timers, hover-pause and the card; this
 * owns what is inside it.
 *
 * `role="status"` / `role="alert"` is on this element rather than on sonner's `<li>`, which carries
 * no role of its own — only the `<section>` wrapper is `aria-live="polite"`. `ArchivedSessions.test
 * .tsx:131` queries `getByRole("status")` and reaches for a button inside it, so the role has to sit
 * on a node that also contains the actions. That is why these go through `toast.custom` rather than
 * `toast(message, { action })`: a notice can carry several actions plus a retry, and sonner's own
 * structure has exactly one `action` and one `cancel` slot.
 */
function Notice({ notice }: { notice: ToastNotice }) {
  // Sonner keeps a dismissed toast mounted for its 200ms exit. The hand-written stack dropped the
  // row from state the instant it was dismissed, so a stale notice was never in the accessibility
  // tree beside a fresh one (`App.test.tsx:671` reads `getByRole("status")` right after both).
  // Leaving on `aria-hidden` keeps the exit animation and restores that.
  const [leaving, setLeaving] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // Whatever had focus when this notice mounted — sonner does not move focus for a
  // `dismissible: false` toast, so this is still the control the user pressed.
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
  }, []);
  useEffect(() => {
    const flag = () => setLeaving(true);
    leavingSetters.set(notice.id, flag);
    return () => {
      if (leavingSetters.get(notice.id) === flag) leavingSetters.delete(notice.id);
    };
  }, [notice.id]);
  const close = () => {
    // `aria-hidden` on a subtree that still holds focus is an accessibility fault, and sonner
    // restores focus itself only for a dismissible toast — these are not. Hand focus back to the
    // control that raised the notice, or drop it deliberately if that control is gone.
    const active = document.activeElement;
    if (active instanceof HTMLElement && row.current?.contains(active)) {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
      else active.blur();
    }
    setLeaving(true);
    toast.dismiss(notice.id);
  };
  return (
    <div
      ref={row}
      role={leaving ? undefined : notice.error ? "alert" : "status"}
      aria-hidden={leaving || undefined}
      className="flex min-w-0 flex-1 items-center gap-2.5 text-sm"
    >
      {notice.icon === "archive" && (
        <Archive width={16} height={16} aria-hidden="true" className="shrink-0" />
      )}
      <span
        className={`min-w-0 [overflow-wrap:anywhere] ${notice.error ? "text-error" : ""}`}
      >
        {notice.message}
      </span>
      {notice.actions?.map((action) => (
        <Button
          key={action.label}
          variant={action.primary ? "default" : "secondary"}
          size="sm"
          className="ms-auto h-6 shrink-0 px-2 text-xs"
          onClick={() => {
            close();
            void Promise.resolve()
              .then(action.onClick)
              .catch((error) => notify(errorMessage(error), true));
          }}
        >
          {action.label}
        </Button>
      ))}
      {notice.retry && (
        <Button
          variant="secondary"
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={notice.retry}
        >
          Retry
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss notification"
        className={cn(iconButtonXs, "shrink-0")}
        onClick={close}
      >
        <X width={14} height={14} />
      </Button>
    </div>
  );
}

/** The hand-written stack's cap. It dropped the oldest row; `visibleToasts` does not. */
const MAX_NOTICES = 4;

/**
 * Mounted once, at `App.tsx:1160`. It is the `brigadier-toast` window event's only listener and now
 * forwards each notice to sonner instead of holding its own list, portal and timer map.
 *
 * Behaviour kept from the hand-written version: top-centre at a 50px offset, at most four live,
 * 6s for a plain notice and no auto-dismiss for an error, hover and focus pause the countdown
 * (sonner's own), and re-notifying with the same `id` replaces the row rather than stacking.
 */
export function Toasts() {
  useEffect(() => {
    // Oldest first. `visibleToasts` alone is not the old behaviour: sonner keeps an over-cap toast
    // mounted and merely paints it `opacity: 0`, so it stays in the accessibility tree, and an
    // error notice has `duration: Infinity` and never leaves on its own. Dropping the oldest id
    // before the fifth is pushed is what the hand-written stack did.
    const live: string[] = [];
    const forget = (id: string) => {
      const at = live.indexOf(id);
      if (at >= 0) live.splice(at, 1);
    };
    const show = (event: Event) => {
      const notice = (event as CustomEvent<ToastNotice>).detail;
      // Re-notifying with the same id replaces the row in place; it is not a new entry.
      if (!live.includes(notice.id)) {
        while (live.length >= MAX_NOTICES) {
          const oldest = live.shift()!;
          leavingSetters.get(oldest)?.();
          toast.dismiss(oldest);
        }
        live.push(notice.id);
      }
      toast.custom(() => <Notice notice={notice} />, {
        id: notice.id,
        duration: notice.error ? Infinity : 6000,
        // Swipe-to-dismiss is off, as it was before: the row has an explicit dismiss button. It
        // also keeps sonner off `setPointerCapture`, which jsdom does not implement. It does not
        // affect `toast.dismiss`, which is what the buttons call.
        dismissible: false,
        // The 6s timer expiring is a close like any other: drop the role for the exit and free
        // the slot. `onDismiss` covers `toast.dismiss` from the row's own buttons.
        onAutoClose: () => {
          leavingSetters.get(notice.id)?.();
          forget(notice.id);
        },
        onDismiss: () => {
          leavingSetters.get(notice.id)?.();
          forget(notice.id);
        },
      });
    };
    window.addEventListener("brigadier-toast", show);
    return () => window.removeEventListener("brigadier-toast", show);
  }, []);
  // Portalled to `document.body`, as the hand-written stack was. Sonner renders its `<section>`
  // in place, and `DesktopSettings` hides the app tree behind it from the accessibility tree — an
  // in-tree toaster goes with it (`App.test.tsx:671` catches exactly that).
  return createPortal(
    <Toaster
      position="top-center"
      offset={50}
      // The cap that matters is `MAX_NOTICES` above. This is the same number one higher, so a
      // toast still mid-exit cannot push a live one out of sight while it unmounts.
      visibleToasts={MAX_NOTICES + 1}
    />,
    document.body,
  );
}
