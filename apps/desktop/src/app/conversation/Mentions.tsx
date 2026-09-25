import type { Unstable_TriggerItem } from "@assistant-ui/react";
import { Chat, File } from "@openai/apps-sdk-ui/components/Icon";
import { type FC, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { WorkerGlyph } from "@/app/conversation/Agents";
import type { ChipMention } from "@/components/assistant-ui/elements/composer-chips";
import {
  ComposerMentions,
  type MentionOption,
} from "@/components/assistant-ui/elements/composer-mentions";
import type { Conversation, Mention } from "@/ipc/generated";
import { listFiles } from "@/state/actions";
import { useBoard } from "@/state/board";
import { useApp } from "@/state/store";

/** A worker the composer can @-mention. */
export type MentionTarget = { id: string; number: number; title: string; state: string };

/** Files matching a query that the menu lists; ChatGPT shows a handful. */
const FILE_ROWS = 8;
/** Other conversations the menu lists. */
const CHAT_ROWS = 5;

const TASK = /@task-(\d+)\b/g;

/** What a mention leaves in the text, after `@`. */
function label(mention: Mention, targets: readonly MentionTarget[]): string | null {
  switch (mention.type) {
    case "task": {
      const target = targets.find((entry) => entry.id === mention.id);
      return target ? `task-${target.number}` : null;
    }
    case "file":
      return mention.path;
    case "chat":
      return mention.title;
  }
}

/**
 * What a message mentions: the workers it names as `@task-N`, and the files and
 * conversations picked from the menu (`known`) whose `@name` is still in the text.
 */
export function mentionsIn(
  text: string,
  targets: readonly MentionTarget[],
  known: Iterable<Mention>,
): Mention[] {
  const mentions: Mention[] = [];
  const tasks = new Set<string>();
  for (const match of text.matchAll(TASK)) {
    const target = targets.find((entry) => entry.number === Number(match[1]));
    if (target && !tasks.has(target.id)) {
      tasks.add(target.id);
      mentions.push({ type: "task", id: target.id });
    }
  }
  const seen = new Set<string>();
  for (const mention of known) {
    if (mention.type === "task") continue;
    const name = label(mention, targets);
    const key = `${mention.type}:${mention.type === "file" ? mention.path : mention.id}`;
    if (name && !seen.has(key) && text.includes(`@${name}`)) {
      seen.add(key);
      mentions.push(mention);
    }
  }
  return mentions;
}

/** The files and conversations the `@` menu put in the composer, by their `@name`. */
export class MentionMemory {
  private readonly byLabel = new Map<string, Mention>();
  /** The open session's workers, whose `@task-N` chips too. */
  private workers: readonly MentionTarget[] = [];

  setWorkers(workers: readonly MentionTarget[]): void {
    this.workers = workers;
  }

  record(mention: Mention, name: string): void {
    this.byLabel.set(name, mention);
  }

  /** Remembers the files and conversations a message, queued item or draft mentions. */
  recall(mentions: readonly Mention[]): void {
    for (const mention of mentions) {
      if (mention.type === "file") this.record(mention, mention.path);
      else if (mention.type === "chat") this.record(mention, mention.title);
    }
  }

  known(): Iterable<Mention> {
    return this.byLabel.values();
  }

  /** Each remembered mention with its `@name`. */
  entries(): Iterable<[string, Mention]> {
    return this.byLabel.entries();
  }

  /**
   * The mention whose name starts at `at` in `text` (just past an `@`): the longest remembered
   * file or conversation, else a worker as `task-N`.
   */
  match(text: string, at: number): ChipMention | null {
    let best: [string, Mention] | null = null;
    for (const entry of this.byLabel) {
      if (text.startsWith(entry[0], at) && entry[0].length > (best?.[0].length ?? 0)) best = entry;
    }
    if (best) return itemOf(best[1], best[0]);
    const task = /^task-(\d+)/.exec(text.slice(at));
    const target = task && this.workers.find((entry) => entry.number === Number(task[1]));
    return target && task ? itemOf({ type: "task", id: target.id }, task[0]) : null;
  }
}

/** A mention's menu item: its id is unique across kinds, its label goes in the text. */
function itemOf(mention: Mention, name: string): Unstable_TriggerItem {
  const id = mention.type === "file" ? `file:${mention.path}` : `${mention.type}:${mention.id}`;
  return { id, type: mention.type, label: name };
}

/** The mention behind a menu item or chip (see `itemOf`). */
export function mentionOf(item: { id: string; type: string; label: string }): Mention | null {
  const rest = item.id.slice(item.id.indexOf(":") + 1);
  switch (item.type) {
    case "file":
      return { type: "file", path: rest };
    case "chat":
      return { type: "chat", id: rest, title: item.label };
    case "task":
      return { type: "task", id: rest };
    default:
      return null;
  }
}

/** How well a file's path matches: its name starting with the query first. */
function fileRank(path: string, query: string): number {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return lower.includes(query) ? 2 : 3;
}

/** A session checkout's files, fetched again when a worker lands something; null until then. */
export function useCheckoutFiles(
  conversation: Conversation | null,
): { files: string[]; truncated: boolean } | null {
  const id = conversation?.kind === "session" ? conversation.id : null;
  const landed = useBoard((s) =>
    s.board?.conversationId === id && s.board
      ? Object.values(s.board.tasks).filter((task) => task.landed !== null).length
      : 0,
  );
  const [fetched, setFetched] = useState<{
    id: string;
    /** The landings it was listed after. */
    landed: number;
    files: string[];
    truncated: boolean;
  } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    listFiles(id)
      .then((list) => live && setFetched({ id, landed, ...list }))
      .catch(() => live && setFetched({ id, landed, files: [], truncated: false }));
    return () => {
      live = false;
    };
  }, [id, landed]);
  return fetched && fetched.id === id ? fetched : null;
}

/**
 * ChatGPT's `@` menu with what Brigadier can mention: a session's workers (as `@task-N`) and
 * its checkout's files, and other chats and sessions, whose latest messages go along.
 */
export const Mentions: FC<{
  conversation: Conversation;
  targets: readonly MentionTarget[];
}> = ({ conversation, targets }) => {
  const files = useCheckoutFiles(conversation);
  const chats = useApp(
    useShallow((s) =>
      Object.values(s.conversations)
        .filter((other) => other.id !== conversation.id && other.lifecycle !== "archived")
        .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs),
    ),
  );
  const search = useCallback(
    (query: string): MentionOption[] => {
      const lower = query.toLowerCase();
      const options: MentionOption[] = [];
      const add = (mention: Mention, name: string, option: Omit<MentionOption, "item">) => {
        options.push({ item: itemOf(mention, name), ...option });
      };
      for (const target of targets) {
        const name = `task-${target.number}`;
        if (!name.includes(lower) && !target.title.toLowerCase().includes(lower)) continue;
        add({ type: "task", id: target.id }, name, {
          icon: <WorkerGlyph taskId={target.id} />,
          detail: target.title,
          trailing: target.state,
        });
      }
      if (lower && files) {
        const matches = files.files
          .map((path) => ({ path, rank: fileRank(path, lower) }))
          .filter((entry) => entry.rank < 3)
          .toSorted((a, b) => a.rank - b.rank || a.path.length - b.path.length)
          .slice(0, FILE_ROWS);
        for (const { path } of matches) {
          const slash = path.lastIndexOf("/");
          add({ type: "file", path }, path, {
            icon: <File />,
            name: path.slice(slash + 1),
            detail: slash > 0 ? path.slice(0, slash) : undefined,
          });
        }
      }
      const shown = chats.filter((chat) => chat.title.toLowerCase().includes(lower));
      for (const chat of shown.slice(0, CHAT_ROWS)) {
        add({ type: "chat", id: chat.id, title: chat.title }, chat.title, { icon: <Chat /> });
      }
      return options;
    },
    [targets, files, chats],
  );

  const hint = useMemo(
    () => (query: string) =>
      !query && files && files.files.length > 0 ? "Type to search for files" : null,
    [files],
  );

  return <ComposerMentions search={search} hint={hint} />;
};
