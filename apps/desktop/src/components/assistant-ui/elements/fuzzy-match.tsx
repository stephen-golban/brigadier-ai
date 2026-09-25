import { unstable_useTriggerPopoverScopeContextOptional } from "@assistant-ui/react";
import type { FC } from "react";

/**
 * Where `query` matches `text`, as ChatGPT's `/` and `@` menus match: at its start, anywhere
 * in it, or letter by letter in order. The positions of the matched letters, and how good the
 * match is (0 = start, 1 = anywhere, 2 = letter by letter); null when it doesn't match.
 */
export function fuzzyMatch(text: string, query: string): { rank: 0 | 1 | 2; at: number[] } | null {
  const lower = text.toLowerCase();
  const want = query.toLowerCase();
  const run = (from: number) => Array.from(want, (_, index) => from + index);
  if (lower.startsWith(want)) return { rank: 0, at: run(0) };
  const inside = lower.indexOf(want);
  if (inside >= 0) return { rank: 1, at: run(inside) };
  const at: number[] = [];
  let from = 0;
  for (const letter of want) {
    const found = lower.indexOf(letter, from);
    if (found < 0) return null;
    at.push(found);
    from = found + 1;
  }
  return { rank: 2, at };
}

/**
 * A menu row's name with what the typed query matched in full white and the rest dimmed, as
 * ChatGPT's menus show it. Inside a trigger popover it reads the query; elsewhere it is plain.
 */
export const MatchedText: FC<{ text: string }> = ({ text }) => {
  const query = unstable_useTriggerPopoverScopeContextOptional()?.query ?? "";
  const match = query ? fuzzyMatch(text, query) : null;
  if (!match) return text;
  const matched = new Set(match.at);
  // Runs of matched and unmatched letters, each keyed by where it starts.
  const runs: { from: number; text: string; hit: boolean }[] = [];
  Array.from(text).forEach((letter, index) => {
    const hit = matched.has(index);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += letter;
    else runs.push({ from: index, text: letter, hit });
  });
  return (
    <>
      {runs.map((run) => (
        <span key={run.from} className={run.hit ? "text-foreground" : "text-muted-foreground"}>
          {run.text}
        </span>
      ))}
    </>
  );
};
