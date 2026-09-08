import type { MessageEditProps } from "./EditMessage";
import { SelectMenu } from "./SelectMenu";
import type { AgentOptions } from "../agentOptions";
/** One chat composer: start a session, or continue the selected conversation. */
import { Composer } from "./Composer";
import { ModelIcon, PathIcon, ProjectIcon } from "./icons";
import { NewSession } from "./NewSession";
import type { SessionRuntime } from "../feedStore";
import type {
  ModelInfo,
  PermissionMode,
  ProjectId,
  ProjectView,
  SessionId,
  WorktreeCleanup,
} from "../wire";

export interface DockProps extends MessageEditProps {
  project: ProjectView | null;
  /** The selected session, or null when none is. Selects the conversation to continue. */
  session: SessionRuntime | null;
  models: ModelInfo[];
  /** An IPC call started here is in flight. */
  busy: boolean;
  /** The `claude` probe failed: nothing may be started, the composer is disabled. */
  blocked: boolean;
  onStartSession: (args: {
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    permissionMode: PermissionMode;
    options?: AgentOptions;
    isolated?: boolean;
  }) => void | Promise<boolean>;
  onSend: (sessionId: SessionId, text: string) => void | Promise<boolean>;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
  onResume: (sessionId: SessionId) => void;
  onCleanup: (
    sessionId: SessionId,
    force: boolean,
  ) => Promise<WorktreeCleanup | null>;
}

/** Last path segment, so a long cwd does not crowd the strip out. Full path stays in `title`. */
function basename(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

export function Dock(props: DockProps) {
  const { project, session, models, busy, blocked } = props;

  const cwd = session?.cwd ?? project?.root_path ?? null;

  return (
    <section
      className={`dock shrink-0 bg-input-shell px-5 pt-2 pb-4 [&>[data-slot=prompt-input]]:mx-auto [&>[data-slot=prompt-input]]:max-w-[780px] ${session ? "has-session" : ""}`}
      aria-label="the composer"
    >
      <div className="dock-context mx-auto mb-2 flex max-w-[780px] items-center gap-2 text-xs text-text-secondary [&_svg]:size-4 [&>span]:inline-flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2">
        <span title={project?.root_path}>
          <span className="glyph">
            <ProjectIcon />
          </span>
          {project?.name ?? "no project"}
        </span>
        {cwd !== null ? (
          <span title={cwd}>
            <span className="glyph">
              <PathIcon />
            </span>
            {session?.cwd != null ? basename(session.cwd) : cwd}
          </span>
        ) : null}
        {session?.model != null ? (
          <span title={session.model}>
            <span className="glyph">
              <ModelIcon />
            </span>
            {session.model}
          </span>
        ) : null}

        <span className="grow" />
        <SelectMenu
          label="Agent"
          value="claude"
          onChange={() => {}}
          options={[
            {
              value: "claude",
              label: "Claude Code",
              description:
                "Connected local CLI. Uses your existing authentication.",
            },
          ]}
        />
      </div>

      {session === null ? (
        <NewSession
          project={project}
          models={models}
          disabled={blocked}
          onStart={props.onStartSession}
        />
      ) : (
        <Composer
          key={`${session.sessionId}:${props.editing?.id ?? "draft"}`}
          editing={props.editing}
          onCancelEdit={props.onCancelEdit}
          onRewound={props.onRewound}
          session={session}
          busy={busy}
          onSend={props.onSend}
          onInterrupt={props.onInterrupt}
          onEnd={props.onEnd}
          onKill={props.onKill}
          onResume={props.onResume}
          onCleanup={props.onCleanup}
        />
      )}
    </section>
  );
}
