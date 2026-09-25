/**
 * While a reply streams, its newest words are dimmer and brighten as the next words arrive
 * (ChatGPT's fade-in). A rehype pass wraps the last words of the last text in spans ranked
 * `aui-tail-1` (newest) to `aui-tail-4`; the styles live in `globals.css`.
 */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const TAIL_WORDS = 4;

/** The last text node outside code, with its parent. */
function lastText(node: HastNode): { parent: HastNode; index: number } | null {
  const children = node.children ?? [];
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index] as HastNode;
    if (child.type === "text" && child.value?.trim()) return { parent: node, index };
    if (child.type === "element" && child.tagName !== "pre" && child.tagName !== "code") {
      const found = lastText(child);
      if (found) return found;
    }
  }
  return null;
}

export function rehypeTailFade() {
  return (tree: HastNode) => {
    const found = lastText(tree);
    if (!found) return;
    const { parent, index } = found;
    const children = parent.children as HastNode[];
    const parts = ((children[index] as HastNode).value ?? "").split(/(\s+)/);
    let cut = parts.length;
    let words = 0;
    for (let at = parts.length - 1; at >= 0 && words < TAIL_WORDS; at--) {
      if (parts[at]?.trim()) {
        words++;
        cut = at;
      }
    }
    const replaced: HastNode[] = [];
    const head = parts.slice(0, cut).join("");
    if (head) replaced.push({ type: "text", value: head });
    let rank = words;
    for (const part of parts.slice(cut)) {
      if (!part.trim()) {
        replaced.push({ type: "text", value: part });
        continue;
      }
      replaced.push({
        type: "element",
        tagName: "span",
        properties: { className: ["aui-tail", `aui-tail-${rank}`] },
        children: [{ type: "text", value: part }],
      });
      rank--;
    }
    children.splice(index, 1, ...replaced);
  };
}
