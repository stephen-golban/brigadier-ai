import { BrandMark } from "./BrandMark";

/** Matches the first-paint markup in index.html without a timed loading sequence. */
export function StartupLoader() {
  return (
    <div className="startup-loader" role="status" aria-label="Opening Brigadier…">
      <div className="startup-brand" aria-hidden="true">
        <BrandMark className="startup-mark" />
      </div>
    </div>
  );
}
