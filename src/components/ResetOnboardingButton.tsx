import { useState } from "react";
import { ArrowRotateCcw } from "../icons";
import { launchApi } from "../launchApi";
import { errorMessage } from "../workspaceApi";
import { Button } from "./controls/button";

export function ResetOnboardingButton({
  className,
  onReset,
}: {
  className?: string;
  onReset?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className={className}>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        title="Start the intro and name setup again. Projects and notes are kept."
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await launchApi.reset();
            onReset?.();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ArrowRotateCcw aria-hidden="true" />
        {busy ? "Resetting…" : "Reset onboarding"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
