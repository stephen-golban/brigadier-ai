import { Plus, Trash } from "@openai/apps-sdk-ui/components/Icon";
import { useId, useState, type FormEvent } from "react";

import { ErrorLine, errorText, Field, FolderField } from "@/app/dialogs/fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Project } from "@/ipc/generated";
import { updateProject } from "@/state/actions";

export type ProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
};

/** Edits a project's name, repository and secrets (new projects: `AddProjectDialog`). */
export function ProjectDialog(props: ProjectDialogProps) {
  return (
    <Dialog open={props.open && props.project !== null} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        {/* Remounted per opening so the fields start from the project. */}
        {props.open && props.project && (
          <SettingsForm project={props.project} onOpenChange={props.onOpenChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Why a secret file path is not acceptable, or `null`. */
function secretFileProblem(path: string): string | null {
  if (!path) return "A secret file path can't be empty.";
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) {
    return `"${path}" must be relative to the repository root.`;
  }
  if (path.split(/[\\/]/).includes("..")) return `"${path}" must stay inside the repository.`;
  return null;
}

function SettingsForm({
  project,
  onOpenChange,
}: {
  project: Project;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const initialRepo = project.repos[0]?.path ?? "";
  const [name, setName] = useState(project.name);
  const [repo, setRepo] = useState(initialRepo);
  const [secrets, setSecrets] = useState<string[]>(project.prefs.secretFiles);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name can't be empty.");
      return;
    }
    const path = repo.trim();
    const files = secrets.map((file) => file.trim());
    const problem = files.map(secretFileProblem).find((entry) => entry !== null);
    if (problem) {
      setError(problem);
      return;
    }
    const secretsChanged =
      files.length !== project.prefs.secretFiles.length ||
      files.some((file, index) => file !== project.prefs.secretFiles[index]);
    setBusy(true);
    setError(null);
    try {
      await updateProject(project.id, {
        name: trimmedName === project.name ? null : trimmedName,
        repos: path === initialRepo ? null : path ? [path] : [],
        prefs: secretsChanged ? { ...project.prefs, secretFiles: files } : null,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Project settings</DialogTitle>
        <DialogDescription>{project.name}</DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        label="Repository"
        htmlFor={`${id}-repo`}
        hint="New sessions work here. Existing sessions keep the repository they started in."
      >
        <FolderField id={`${id}-repo`} value={repo} onChange={setRepo} />
      </Field>
      <Field
        label="Secret env files"
        hint="Gitignored files (paths relative to the repository root) copied into every worker worktree. Their values are redacted in the UI, logs and the Brain."
      >
        <ul className="grid gap-1.5" aria-label="Secret env files">
          {secrets.map((file, index) => (
            <li key={index} className="flex gap-2">
              <Input
                value={file}
                spellCheck={false}
                autoComplete="off"
                placeholder=".env.local"
                aria-label={`Secret file ${index + 1}`}
                className="font-mono text-xs"
                onChange={(event) =>
                  setSecrets((current) =>
                    current.map((entry, at) => (at === index ? event.target.value : entry)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label={`Remove ${file || "this file"}`}
                onClick={() => setSecrets((current) => current.filter((_, at) => at !== index))}
              >
                <Trash />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => setSecrets((current) => [...current, ""])}
        >
          <Plus />
          Add file
        </Button>
      </Field>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
