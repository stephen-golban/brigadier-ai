import { useEffect, useState } from "react";
import {
  CheckCircleIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
interface Toast {
  id: string;
  message: string;
  error: boolean;
  retry?: () => void;
}
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const show = (e: Event) => {
      const toast = (e as CustomEvent<Toast>).detail;
      setToasts((old) => [...old, toast].slice(-4));
      if (!toast.error) {
        const timer = setTimeout(() => {
          setToasts((old) => old.filter((t) => t.id !== toast.id));
          timers.delete(timer);
        }, 4000);
        timers.add(timer);
      }
    };
    window.addEventListener("brigadier-toast", show);
    return () => {
      window.removeEventListener("brigadier-toast", show);
      timers.forEach(clearTimeout);
    };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          {t.error ? (
            <WarningCircleIcon size={20} />
          ) : (
            <CheckCircleIcon size={20} />
          )}
          <span>{t.message}</span>
          {t.retry && (
            <button
              onClick={() => {
                t.retry?.();
                setToasts((old) => old.filter((x) => x.id !== t.id));
              }}
            >
              Retry
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToasts((old) => old.filter((x) => x.id !== t.id))}
          >
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
