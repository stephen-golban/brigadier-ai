import { useEffect, useRef, useState } from "react";
import { Button } from "./controls/button";
interface Notice {
  id: string;
  message: string;
  error: boolean;
  retry?: () => void;
}
export function Toasts() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setNotices((notices) => notices.filter((notice) => notice.id !== id));
  };
  useEffect(() => {
    const show = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail;
      setNotices((notices) => [
        ...notices.filter((item) => item.id !== notice.id),
        notice,
      ]);
      clearTimeout(timers.current.get(notice.id));
      if (!notice.error)
        timers.current.set(
          notice.id,
          setTimeout(() => dismiss(notice.id), 4000),
        );
    };
    const activeTimers = timers.current;
    window.addEventListener("brigadier-toast", show);
    return () => {
      window.removeEventListener("brigadier-toast", show);
      activeTimers.forEach(clearTimeout);
      activeTimers.clear();
    };
  }, []);
  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2"
      aria-label="Notifications"
    >
      {notices.slice(-4).map((notice) => (
        <div
          key={notice.id}
          role={notice.error ? "alert" : "status"}
          className="rounded-md bg-elevated p-3 text-[13px] shadow-overlay"
        >
          <p
            className={
              notice.error ? "text-error" : "text-text"
            }
          >
            {notice.message}
          </p>
          <div className="mt-2 flex justify-end gap-1">
            {notice.retry && <Button onClick={notice.retry}>Retry</Button>}
            <Button
              aria-label="Dismiss notification"
              onClick={() => dismiss(notice.id)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
