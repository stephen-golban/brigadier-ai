import type { SessionStartup } from "../sessionStartup";
import { StartingComposer } from "./composer/StartingComposer";
import type { MessageEditProps } from "./EditMessage";
import type { AgentOptions } from "../agentOptions";
/** One chat composer: start a session, or continue the selected conversation. */
import { Composer } from "./Composer";
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
  startup?: SessionStartup;
  project: ProjectView | null;
  projects?: ProjectView[];
  onSelectProject?: (id: string) => void;
  onNewProject?: () => void; onProjectless?: () => void;
  /** The selected session, or null when none is. Selects the conversation to continue. */
  session: SessionRuntime | null;
  models: ModelInfo[];
  /** An IPC call started here is in flight. */
  busy: boolean;
  /** The `claude` probe failed: nothing may be started, the composer is disabled. */
  blocked: boolean;
  onStartSession: (args: {
    composerMode?: import("../taskSettings").ComposerMode;
    composerPermission?: import("../taskSettings").PermissionPolicy;
    projectId: ProjectId;
    prompt: string;
    model: string | null;
    provider?: string;
  requestId?: string;
    permissionMode: PermissionMode;
    options?: AgentOptions;
    isolated?: boolean;
    baseBranch?: string;
    attachmentIds?: string[];
  }) => void | Promise<boolean>;
  onSend: (sessionId: SessionId, text: string, attachmentIds?: string[]) => void | Promise<boolean>;
  onInterrupt: (sessionId: SessionId) => void;
  onEnd: (sessionId: SessionId) => void;
  onKill: (sessionId: SessionId) => void;
  onResume: (sessionId: SessionId) => void;
  onCleanup: (
    sessionId: SessionId,
    force: boolean,
  ) => Promise<WorktreeCleanup | null>;
}

export function Dock(props: DockProps) {
  const { project, session, models, busy, blocked } = props;


  return (
    <section
      className={`dock composer-dock shrink-0 bg-input-shell ${session ? "has-session" : ""}`}
      aria-label="the composer"
    >
      {props.startup ? <StartingComposer startup={props.startup} project={project}/> : session === null ? (
        <NewSession
          project={project}
          projects={props.projects}
          onSelectProject={props.onSelectProject}
          onNewProject={props.onNewProject} onProjectless={props.onProjectless}
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
          project={project}
          models={models}
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
