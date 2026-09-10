import type { CSSProperties } from "react";

/** A finite, compositor-driven echo of the disc. No render loop remains after settling. */
export function SignalField() {
  return (
    <div className="signal-field" aria-hidden="true">
      <div className="signal-field-lines">
        {Array.from({ length: 15 }, (_, index) => (
          <span key={index} style={{
            "--line-height": `${Math.sqrt(1 - ((index - 7) / 7.3) ** 2) * 100}%`,
            "--line-delay": `${Math.abs(index - 7) * 0.06}s`,
          } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}
