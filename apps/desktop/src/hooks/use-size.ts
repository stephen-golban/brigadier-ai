import { useLayoutEffect, useRef, useState } from "react";

export type Size = { width: number; height: number };

/** An element's content size, kept current as it resizes (0 × 0 until measured). */
export function useSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}
