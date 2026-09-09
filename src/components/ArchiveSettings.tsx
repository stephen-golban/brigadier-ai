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
      <h3>Archive retention</h3>
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
      <p className="text-xs text-text-secondary">
        Deleted chats and everything inside them are permanently removed, including
        exclusively owned worktrees and uncommitted changes. Project repositories
        and shared worktrees are kept. Cleanup runs while Brigadier is open and
        catches up when you reopen it.
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
