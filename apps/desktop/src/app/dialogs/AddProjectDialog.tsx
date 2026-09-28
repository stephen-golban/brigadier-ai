import {
  CheckCircle,
  Folder,
  FolderOpen,
  InfoCircle,
  Warning,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ErrorLine, errorText, Field } from "@/app/dialogs/fields";
import { Spinner } from "@/components/glyphs/spinner";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pickFolder } from "@/ipc/client";
import type { FolderCheck, FolderListing } from "@/ipc/generated";
import { shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  addProject,
  browseFolders,
  checkFolder,
  closeAddProject,
  cloneProject,
  showProject,
  useAddProject,
} from "@/state/addProject";
import { useApp } from "@/state/store";
import { toast } from "@/state/toasts";

/** Typing pauses this long before the folder is listed or checked. */
const LIST_DELAY_MS = 80;
const CHECK_DELAY_MS = 150;

/**
 * Adds a project: a folder on this computer (typed with suggestions, or chosen in the system
 * picker) or a clone of a repository URL.
 */
export function AddProjectDialog() {
  const open = useAddProject((s) => s.open);
  const path = useAddProject((s) => s.path);
  const opening = useAddProject((s) => s.opening);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAddProject()}>
      <DialogContent className="max-w-lg">
        {/* Remounted per opening so the fields start over. */}
        {open && <AddProjectForm key={opening} initialPath={path} />}
      </DialogContent>
    </Dialog>
  );
}

/** The folder new projects usually sit in: the newest project's parent, else home. */
function usualParent(): string {
  const newest = Object.values(useApp.getState().projects)
    .filter((project) => project.repos.length > 0)
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs)[0];
  const repo = newest?.repos[0]?.path;
  if (!repo) return "~/";
  const cut = Math.max(repo.lastIndexOf("/"), repo.lastIndexOf("\\"));
  return cut > 0 ? `${shortPath(repo.slice(0, cut))}/` : "~/";
}

function AddProjectForm({ initialPath }: { initialPath: string }) {
  const [tab, setTab] = useState<"folder" | "clone">("folder");
  const [start] = useState(usualParent);
  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as "folder" | "clone")}>
      <DialogHeader>
        <DialogTitle>Add project</DialogTitle>
        <DialogDescription>
          A project is a git repository your sessions work in.
        </DialogDescription>
      </DialogHeader>
      <TabsList className="mt-2 w-full">
        <TabsTrigger value="folder">Folder on this computer</TabsTrigger>
        <TabsTrigger value="clone">Clone from URL</TabsTrigger>
      </TabsList>
      <TabsContent value="folder" className="mt-2">
        <FolderForm initialPath={initialPath ? shortPath(initialPath) : start} />
      </TabsContent>
      <TabsContent value="clone" className="mt-2">
        <CloneForm initialParent={start} />
      </TabsContent>
    </Tabs>
  );
}

// ----- a folder on this computer ----------------------------------------------------------

/** What submitting does for a checked folder, and whether Enter in the path may do it. */
type Plan = {
  label: string;
  /** Adding makes a repository (and maybe the folder): only a click or ⌘Enter does it. */
  writes: boolean;
  disabled: boolean;
};

function planFor(check: FolderCheck | null, browsing: boolean): Plan {
  if (!check || (browsing && check.kind !== "repo")) {
    return { label: "Add project", writes: false, disabled: true };
  }
  switch (check.kind) {
    case "repo":
      return check.projectId
        ? { label: "Open project", writes: false, disabled: false }
        : { label: "Add project", writes: false, disabled: false };
    case "plain":
      return { label: "Initialize git & add", writes: true, disabled: false };
    case "missing":
      return { label: "Create folder & add", writes: true, disabled: false };
    case "invalid":
      return { label: "Add project", writes: false, disabled: true };
  }
}

function FolderForm({ initialPath }: { initialPath: string }) {
  const id = useId();
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<{ path: string; check: FolderCheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const typed = path.trim();
  useEffect(() => {
    if (!typed) return;
    let live = true;
    const timer = window.setTimeout(() => {
      checkFolder(typed)
        .then((check) => {
          if (live) setChecked({ path: typed, check });
        })
        .catch((cause: unknown) => {
          if (live) setError(errorText(cause));
        });
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [typed]);

  // Only a check of what is typed now counts.
  const check = typed && checked?.path === typed ? checked.check : null;
  // A full path ending in a separator is still being browsed.
  const browsing = /[/\\]$/.test(typed) && /^(~|[/\\]|[A-Za-z]:)/.test(typed);
  const plan = planFor(check, browsing);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!check || plan.disabled || busy) return;
    if (check.kind === "repo" && check.projectId) {
      closeAddProject();
      showProject(check.projectId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await addProject(typed, name.trim(), plan.writes);
      closeAddProject();
      showProject(project.id);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={(event) => void submit(event)} className="grid gap-4">
      <Field label="Folder" htmlFor={`${id}-path`}>
        <PathInput
          id={`${id}-path`}
          value={path}
          onChange={(next) => {
            setPath(next);
            setError(null);
          }}
          onEnter={(force) => {
            if (force || !plan.writes) formRef.current?.requestSubmit();
          }}
          placeholder="~/path/to/project"
          autoFocus
        />
        <FolderStatus check={check} browsing={browsing} empty={!typed} />
      </Field>
      <Field label="Name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={200}
          placeholder={
            check?.kind === "repo" ||
            (!browsing && (check?.kind === "plain" || check?.kind === "missing"))
              ? check.name
              : "Named after the folder"
          }
          disabled={check?.kind === "repo" && check.projectId !== null}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeAddProject}>
          Cancel
        </Button>
        <Button type="submit" disabled={plan.disabled || busy}>
          {busy && <Spinner className="animate-spin" />}
          {plan.label}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What adding the typed folder does, under the path. */
function FolderStatus({
  check,
  browsing,
  empty,
}: {
  check: FolderCheck | null;
  browsing: boolean;
  empty: boolean;
}) {
  const projects = useApp((state) => state.projects);
  if (empty) return <StatusLine>Type a folder's path, or choose it.</StatusLine>;
  if (!check) return <StatusLine>&nbsp;</StatusLine>;
  if (browsing && check.kind !== "repo") {
    return <StatusLine>Pick a folder below, or type a new folder's name.</StatusLine>;
  }
  switch (check.kind) {
    case "repo":
      if (check.projectId) {
        const project = projects[check.projectId];
        return (
          <StatusLine icon={<InfoCircle />}>
            Already the project <strong className="font-medium">{project?.name ?? check.name}</strong>.
          </StatusLine>
        );
      }
      return check.nested ? (
        <StatusLine icon={<InfoCircle />}>
          In the repository at <code className="font-mono">{shortPath(check.root)}</code>, which
          the project uses.
        </StatusLine>
      ) : (
        <StatusLine icon={<CheckCircle />} tone="success">
          Git repository
        </StatusLine>
      );
    case "plain":
      return (
        <StatusLine icon={<Warning />} tone="warning">
          Not a git repository. Adding it runs <code className="font-mono">git init</code> here
          and makes an empty first commit.
        </StatusLine>
      );
    case "missing":
      return (
        <StatusLine icon={<Warning />} tone="warning">
          Doesn't exist yet. Adding it creates the folder with a new git repository.
        </StatusLine>
      );
    case "invalid":
      return (
        <StatusLine icon={<Warning />} tone="error">
          {check.reason}
        </StatusLine>
      );
  }
}

function StatusLine({
  icon,
  tone,
  children,
}: {
  icon?: ReactNode;
  tone?: "success" | "warning" | "error";
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      className={cn(
        "text-muted-foreground flex min-h-4 items-start gap-1.5 text-xs [&_svg]:mt-px [&_svg]:size-icon-sm [&_svg]:shrink-0",
        tone === "success" && "[&_svg]:text-success",
        tone === "warning" && "[&_svg]:text-warning",
        tone === "error" && "text-destructive",
      )}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

// ----- a clone ----------------------------------------------------------------------------

/** `owner/name` is a GitHub repository; anything else is taken as typed. */
function cloneUrl(typed: string): string {
  const url = typed.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url.replace(/\.git$/, "")}.git` : url;
}

/** The folder a clone of `url` goes in by default: its last path part, without `.git`. */
function folderFromUrl(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

function CloneForm({ initialParent }: { initialParent: string }) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(initialParent);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const target = folder.trim() || folderFromUrl(url);
  const into = parent.trim().replace(/[/\\]+$/, "");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!url.trim()) {
      setError("Paste the repository's URL.");
      return;
    }
    if (!target) {
      setError("Name the folder to clone into.");
      return;
    }
    setBusy(true);
    setError(null);
    // The clone goes on if the dialog closes; its outcome then shows as a toast.
    try {
      const project = await cloneProject(cloneUrl(url), into || "/", target, "");
      if (mounted.current) closeAddProject();
      showProject(project.id);
      toast(`Cloned ${project.name}`);
    } catch (cause) {
      if (mounted.current) {
        setError(errorText(cause));
        setBusy(false);
      } else {
        toast(`Could not clone ${target}: ${errorText(cause)}`, { tone: "error" });
      }
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <Field label="Repository URL" htmlFor={`${id}-url`}>
        <Input
          id={`${id}-url`}
          value={url}
          spellCheck={false}
          autoComplete="off"
          placeholder="https://github.com/owner/repo.git or owner/repo"
          className="font-mono text-xs"
          disabled={busy}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
        />
      </Field>
      <Field label="Clone into" htmlFor={`${id}-parent`}>
        <PathInput
          id={`${id}-parent`}
          value={parent}
          onChange={setParent}
          onEnter={() => undefined}
          placeholder="~/code"
          disabled={busy}
        />
      </Field>
      <Field
        label="Folder name"
        htmlFor={`${id}-folder`}
        hint={
          target ? (
            <>
              Clones to <code className="font-mono">{`${into}/${target}`}</code>
            </>
          ) : undefined
        }
      >
        <Input
          id={`${id}-folder`}
          value={folder}
          spellCheck={false}
          autoComplete="off"
          placeholder={folderFromUrl(url) || "repo"}
          className="font-mono text-xs"
          disabled={busy}
          onChange={(event) => setFolder(event.target.value)}
        />
      </Field>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeAddProject}>
          {busy ? "Close" : "Cancel"}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner className="animate-spin" />}
          {busy ? "Cloning…" : "Clone & add"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ----- the path field ---------------------------------------------------------------------

/** The typed path up to and including its last separator: where a picked folder is added. */
function base(path: string): string {
  if (path === "~") return "~/";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

/**
 * A folder path with the folders it points into listed below as it is typed: ↑↓ pick one,
 * Tab or Enter goes into it, Enter with none picked hands over to `onEnter` (⌘Enter forces).
 * "Choose…" opens the system folder picker.
 */
function PathInput({
  id,
  value,
  onChange,
  onEnter,
  placeholder,
  autoFocus,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: (force: boolean) => void;
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [listing, setListing] = useState<{ path: string; listing: FolderListing } | null>(null);
  // Listed once the field is used; blurring keeps the list, so the buttons below don't move
  // under a click.
  const [engaged, setEngaged] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const listId = `${id}-list`;

  const typed = value.trim();
  useEffect(() => {
    if (!typed) return;
    let live = true;
    const timer = window.setTimeout(() => {
      browseFolders(typed)
        .then((found) => {
          if (live) setListing({ path: typed, listing: found });
        })
        .catch(() => {
          if (live) setListing({ path: typed, listing: { dir: "", entries: [], truncated: false } });
        });
    }, LIST_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [typed]);

  // The last listing stays up while the next loads, so the list doesn't flicker.
  const entries = typed ? (listing?.listing.entries ?? []) : [];
  const shown = engaged && !dismissed && !disabled && entries.length > 0;

  const change = (next: string) => {
    onChange(next);
    setHighlight(-1);
    setDismissed(false);
  };
  const enter = (index: number) => {
    const entry = entries[index];
    if (entry) change(`${base(value)}${entry.name}/`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (shown && highlight >= 0 && !(event.metaKey || event.ctrlKey)) enter(highlight);
      else onEnter(event.metaKey || event.ctrlKey);
      return;
    }
    if (!shown) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // Past either end, nothing is picked: Enter then hands over again.
      const down = event.key === "ArrowDown";
      setHighlight((at) => {
        if (down) return at >= entries.length - 1 ? -1 : at + 1;
        return at < 0 ? entries.length - 1 : at - 1;
      });
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      enter(Math.max(highlight, 0));
    } else if (event.key === "Escape") {
      // Closes the list, not the dialog.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      setHighlight(-1);
    }
  };

  return (
    <div className="grid gap-1">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={id}
            value={value}
            autoFocus={autoFocus}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            className="font-mono text-xs"
            role="combobox"
            aria-expanded={shown}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown && highlight >= 0 ? `${listId}-${highlight}` : undefined}
            onFocus={() => setEngaged(true)}
            onKeyDown={onKeyDown}
            onChange={(event) => change(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setError(null);
            pickFolder(listing?.listing.dir || undefined)
              .then((picked) => {
                if (picked) change(shortPath(picked));
              })
              .catch((cause: unknown) => setError(errorText(cause)));
          }}
        >
          <FolderOpen />
          Choose…
        </Button>
      </div>
      {shown && (
        <div
          id={listId}
          role="listbox"
          aria-label="Folders"
          className="bg-muted/30 rounded-menu max-h-48 overflow-y-auto border p-1"
        >
          {entries.map((entry, index) => (
            <button
              type="button"
              tabIndex={-1}
              key={entry.path}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              // Keeps the focus in the field.
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setHighlight(index)}
              onClick={() => enter(index)}
              className={cn(
                "rounded-capsule min-h-control-sm flex w-full cursor-default items-center gap-2 px-2 text-start text-sm [&_svg]:size-icon-md [&_svg]:shrink-0",
                index === highlight && "bg-foreground/8",
              )}
            >
              <Folder className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {entry.projectId ? (
                <span className="text-muted-foreground text-xs">Added</span>
              ) : entry.repo ? (
                <span className="text-muted-foreground text-xs">git</span>
              ) : null}
            </button>
          ))}
          {listing?.listing.truncated && (
            <p className="text-muted-foreground px-2 py-1 text-xs">
              More folders match. Keep typing to narrow them.
            </p>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
