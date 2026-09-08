import { useState } from "react";
import {
  archiveDefaults,
  saveArchiveSettings,
  useSessionArchive,
} from "../sessionArchive";
import { Checkbox } from "./controls/checkbox";
import { Input } from "./controls/input";
import { Button } from "./controls/button";
import { errorMessage } from "../workspaceApi";
export function ArchiveSettings() {
  const { settings } = useSessionArchive();
  const [value, setValue] = useState(settings ?? archiveDefaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        try {
          await saveArchiveSettings(value);
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3>Archived sessions</h3>
      <Checkbox
        checked={value.autoDelete}
        disabled={saving}
        onCheckedChange={(checked) =>
          setValue((v) => ({ ...v, autoDelete: checked }))
        }
      >
        Automatically delete archived sessions
      </Checkbox>
      <label>
        Delete after (days)
        <Input
          type="number"
          min={1}
          max={36500}
          required
          disabled={saving || !value.autoDelete}
          value={value.retentionDays}
          onChange={(e) =>
            setValue((v) => ({ ...v, retentionDays: Number(e.target.value) }))
          }
        />
      </label>
      <Checkbox
        checked={value.deleteWorktrees}
        disabled={saving}
        onCheckedChange={(checked) =>
          setValue((v) => ({ ...v, deleteWorktrees: checked }))
        }
      >
        Delete isolated worktrees with expired sessions
      </Checkbox>
      <p className="text-xs text-text-secondary">
        Checked when Brigadier opens and while it is running. Worktrees with
        unsaved changes or unique commits are kept for review. Project folders
        are always kept.
      </p>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save retention settings"}
      </Button>
    </form>
  );
}
