import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, X } from "lucide-react";
import { notify, type ToastNotice } from "../desktopApi";
import { errorMessage } from "../workspaceApi";
import { Button } from "./controls/button";
import "./settings.css";

export function Toasts() {
  const [notices, setNotices] = useState<ToastNotice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setNotices((items) => items.filter((notice) => notice.id !== id));
  };
  const schedule = (notice: ToastNotice) => {
    clearTimeout(timers.current.get(notice.id));
    if (!notice.error)
      timers.current.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), 6000),
      );
  };
  useEffect(() => {
    const show = (event: Event) => {
      const notice = (event as CustomEvent<ToastNotice>).detail;
      setNotices((items) =>
        [...items.filter((item) => item.id !== notice.id), notice].slice(-4),
      );
      schedule(notice);
    };
    const activeTimers = timers.current;
    window.addEventListener("brigadier-toast", show);
    return () => {
      window.removeEventListener("brigadier-toast", show);
      activeTimers.forEach(clearTimeout);
      activeTimers.clear();
    };
  }, []);
  return createPortal(
    <div className="app-toasts" aria-label="Notifications">
      {notices.map((notice) => (
        <div
          key={notice.id}
          role={notice.error ? "alert" : "status"}
          className={`app-toast${notice.error ? " app-toast-error" : ""}`}
          onMouseEnter={() => clearTimeout(timers.current.get(notice.id))}
          onMouseLeave={() => schedule(notice)}
          onFocus={() => clearTimeout(timers.current.get(notice.id))}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              schedule(notice);
          }}
        >
          {notice.icon === "archive" && (
            <Archive size={16} aria-hidden="true" />
          )}
          <span>{notice.message}</span>
          {notice.actions?.map((action) => (
            <Button
              key={action.label}
              className={action.primary ? "toast-primary" : "toast-action"}
              onClick={() => {
                dismiss(notice.id);
                void Promise.resolve()
                  .then(action.onClick)
                  .catch((error) => notify(errorMessage(error), true));
              }}
            >
              {action.label}
            </Button>
          ))}
          {notice.retry && <Button onClick={notice.retry}>Retry</Button>}
          <Button
            size="icon-xs"
            aria-label="Dismiss notification"
            onClick={() => dismiss(notice.id)}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
