import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  EditPencil,
  Stop,
} from "@openai/apps-sdk-ui/components/Icon";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FC,
} from "react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Optional overrides: `AssistantMessage`, `Welcome` and `Composer` replace whole sections;
 * `BeforeMessages` renders above the message list (e.g. a "load earlier" control);
 * `MessageFooter` renders under each user or assistant message (attachments);
 * `AboveComposer` renders between the messages and the composer (queue, notices).
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  BeforeMessages?: ComponentType | undefined;
  MessageFooter?: ComponentType | undefined;
  AboveComposer?: ComponentType | undefined;
  Composer?: ComponentType<ComposerProps> | undefined;
};

export type ComposerProps = { autoFocus: boolean; placeholder: string };

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  placeholder?: string | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 delay-150 duration-200"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="h-control-lg ms-auto w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="h-control-lg ms-auto w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  placeholder = "Send a message...",
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot
        isEmpty={isEmpty}
        autoFocus={autoFocus}
        placeholder={placeholder}
      />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  autoFocus: boolean;
  placeholder: string;
}> = ({ isEmpty, autoFocus, placeholder }) => {
  const {
    Welcome = ThreadWelcome,
    BeforeMessages,
    AboveComposer,
    Composer: ComposerComponent = Composer,
  } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root className="aui-root aui-thread-root bg-background @container flex h-full flex-col">
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "max-w-thread mx-auto flex w-full flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>
          {BeforeMessages && <BeforeMessages />}

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4",
              !isEmpty && "rounded-t-thread sticky bottom-0 mt-auto",
            )}
          >
            <ThreadScrollToBottom />
            {AboveComposer && <AboveComposer />}
            <ComposerComponent autoFocus={autoFocus} placeholder={placeholder} />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const editing = useAuiState((s) => s.message.composer.isEditing);

  if (role === "user") return editing ? <EditComposer /> : <UserMessage />;
  if (role === "system") return <SystemMessage />;
  return <AssistantMessageComponent />;
};

/** A line from Brigadier itself (an environment problem, a fallback), not from a model. */
const SystemMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_system-message-root"
    data-role="system"
    className="message-contain text-muted-foreground flex justify-center px-2 text-center text-xs"
  >
    <p className="max-w-4/5 whitespace-pre-wrap">
      <MessagePrimitive.Parts />
    </p>
  </MessagePrimitive.Root>
);

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        size="icon-lg"
        className="aui-thread-scroll-to-bottom border-border bg-background hover:bg-accent rounded-capsule absolute -top-12 z-10 self-center disabled:invisible"
      >
        <ArrowDown />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-display text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </p>
    </div>
  );
};

const Composer: FC<ComposerProps> = ({
  autoFocus,
  placeholder,
}) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div
        data-slot="aui_composer-shell"
        className="border-foreground/10 focus-within:border-foreground/25 bg-muted/30 rounded-thread flex w-full cursor-text flex-col gap-2 border p-2 transition-[border-color]"
      >
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 min-h-composer max-h-48 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message input"
        />
        <ComposerAction />
      </div>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-end gap-1.5">
      <AuiIf condition={(s) => !s.composer.canCancel}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="Send message"
            side="bottom"
            type="button"
            variant="default"
            size="icon-md"
            className="aui-composer-send rounded-capsule"
            aria-label="Send message"
          >
            <ArrowUp className="aui-composer-send-icon" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.composer.canCancel}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon-md"
            className="aui-composer-cancel rounded-capsule"
            aria-label="Stop generating"
          >
            <Stop className="aui-composer-cancel-icon size-icon-sm" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

export const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/5 text-destructive mt-2 rounded-md border p-3 text-sm">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

// The markdown stack (remark, micromark, mdast) loads with the first reply, not at startup.
const MarkdownText = lazy(() =>
  import("@/components/assistant-ui/markdown-text").then((module) => ({
    default: module.MarkdownText,
  })),
);

export const MessageText: FC<TextMessagePartProps> = (props) => (
  <Suspense fallback={<p className="whitespace-pre-wrap">{props.text}</p>}>
    <MarkdownText {...props} />
  </Suspense>
);

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in message-contain relative -mb-7.5 pb-7.5 duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.Parts components={{ Text: MessageText }} />
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className="ms-2 flex min-h-7.5 items-center gap-2 pt-1.5"
      >
        <AssistantActionBar />
        <MessageFooter />
      </div>
    </MessagePrimitive.Root>
  );
};

const MessageFooter: FC = () => {
  const { MessageFooter: Footer } = useContext(ThreadComponentsContext);
  return Footer ? <Footer /> : null;
};

const CopyIcon: FC = () => (
  <>
    <AuiIf condition={(s) => s.message.isCopied}>
      <Check className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
    </AuiIf>
    <AuiIf condition={(s) => !s.message.isCopied}>
      <Copy className="animate-in zoom-in-75 fade-in duration-150" />
    </AuiIf>
  </>
);

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <CopyIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/user fade-in slide-in-from-bottom-1 animate-in message-contain flex flex-col items-end gap-y-1 px-2 duration-150"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper flex max-w-7/10 min-w-0 flex-col items-end gap-y-1">
        <UserMessageText />
        <MessageFooter />
        <div className="aui-user-action-bar-wrapper peer-empty:hidden opacity-0 transition-opacity group-hover/user:opacity-100 group-focus-within/user:opacity-100">
          <UserActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

/** The user's text in its bubble; a long message is clipped until "Show more". */
const UserMessageText: FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const hasText = useAuiState((s) =>
    s.message.parts.some((part) => part.type === "text" && part.text !== ""),
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Files only: an empty bubble hides itself (and the action bar beside it).
  if (!hasText) return <div className="aui-user-message-content peer empty:hidden" />;
  return (
    <div className="aui-user-message-content peer bg-muted text-foreground rounded-thread flex flex-col px-4 py-2 empty:hidden">
      <div
        ref={ref}
        className={cn(
          "whitespace-pre-wrap wrap-break-word",
          !expanded && "max-h-user-message overflow-hidden",
        )}
      >
        <MessagePrimitive.Parts />
      </div>
      {(clipped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground self-start pt-1 text-xs"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
};

/** Whether the message may be edited or answered again now (the view decides, per message). */
const canRework = (s: AssistantState) => s.message.metadata.custom["rework"] === true;

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root className="aui-user-action-bar-root text-muted-foreground flex items-center gap-1">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" className="aui-user-action-copy">
          <CopyIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={canRework}>
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="Edit message" className="aui-user-action-edit">
            <EditPencil />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </AuiIf>
      <BranchPicker />
    </ActionBarPrimitive.Root>
  );
};

/** "‹ 2/3 ›" between the versions of a message (edits, or answers given again). */
export const BranchPicker: FC = () => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className="aui-branch-picker-root text-muted-foreground inline-flex items-center text-xs"
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous version">
          <ChevronLeft />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next version">
          <ChevronRight />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

/** A sent message being edited: the text in place, then cancel or send the new version. */
const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-root"
      data-role="user"
      className="message-contain flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="bg-muted rounded-thread ms-auto flex w-full flex-col gap-2 p-2">
        <ComposerPrimitive.Input
          autoFocus
          aria-label="Edit message"
          className="text-foreground max-h-user-message min-h-composer w-full resize-none bg-transparent px-2 py-1 text-base outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Send</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
