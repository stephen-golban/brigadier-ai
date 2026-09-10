import type { CSSProperties } from "react";

/** Animate fragments of the selected master; the resolved geometry is the same logo. */
export function IntroDisc() {
  return (
    <div className="intro-disc" aria-hidden="true">
      <svg viewBox="0 0 256 256" fill="currentColor">
        {Array.from({ length: 15 }, (_, index) => (
          <use
            key={index}
            className="intro-disc-stripe"
            href={`/brand/striped-disc.svg#stripe-${index}`}
            style={{
              "--stripe-delay": `${0.3 + Math.abs(index - 7) * 0.055}s`,
              "--stripe-drift": `${index % 2 ? -90 : 90}px`,
            } as CSSProperties}
          />
        ))}
        <use className="intro-disc-core" href="/brand/striped-disc.svg#disc-core" />
      </svg>
    </div>
  );
}
