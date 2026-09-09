/** Preserve literal source. Formatting inserts Markdown delimiters without escaping paths/text. */
import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type LexicalNode } from "lexical";
import { $isLinkNode } from "@lexical/link";
import { $isCodeNode } from "@lexical/code";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $isListNode, $isListItemNode } from "@lexical/list";

function inline(node: LexicalNode): string {
  if ($isLineBreakNode(node)) return "\n";
  if ($isTextNode(node)) {
    let text = node.getTextContent();
    if (!text) return text;
    if (node.hasFormat("code")) {
      const fence = "`".repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1);
      text = `${fence}${text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
    }
    if (node.hasFormat("bold")) text = `**${text}**`;
    if (node.hasFormat("italic")) text = `*${text}*`;
    if (node.hasFormat("strikethrough")) text = `~~${text}~~`;
    return text;
  }
  if ($isLinkNode(node)) return `[${node.getChildren().map(inline).join("")}](${node.getURL()}${node.getTitle() ? ` "${node.getTitle()}"` : ""})`;
  if ($isElementNode(node)) return node.getChildren().map(inline).join("");
  // assistant-ui DirectiveNode returns its stable serialized reference, not its display label.
  return node.getTextContent();
}
function block(node: LexicalNode, depth = 0): string {
  if ($isCodeNode(node)) {
    const text = node.getTextContent();
    const fence = "`".repeat(Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1);
    return `${fence}${node.getLanguage() ?? ""}\n${text}\n${fence}`;
  }
  if ($isHeadingNode(node)) return `${"#".repeat(Number(node.getTag().slice(1)))} ${inline(node)}`;
  if ($isQuoteNode(node)) return inline(node).split("\n").map(line => `> ${line}`).join("\n");
  if ($isListNode(node)) return node.getChildren().map((item, index) => {
    const prefix = node.getListType() === "number" ? `${node.getStart() + index}. ` : node.getListType() === "check" ? `- [${$isListItemNode(item) && item.getChecked() ? "x" : " "}] ` : "- ";
    const parts = $isElementNode(item) ? item.getChildren() : [item];
    return `${"  ".repeat(depth)}${prefix}${parts.filter(child => !$isListNode(child)).map(inline).join("")}${parts.filter($isListNode).map(child => `\n${block(child, depth + 1)}`).join("")}`;
  }).join("\n");
  return inline(node);
}
export function $editorSource(): string { return $getRoot().getChildren().map(node => block(node)).join("\n"); }

export interface ReferenceToken { start: number; end: number; id: string; label: string; type: "attachment" | "note" | "session"; source: string }
export function referenceTokens(text: string): ReferenceToken[] {
  return Array.from(text.matchAll(/@\[([^\]\n]*)\]\(brigadier-(attachment|note|session):([^\s)]+)\)/g), match => ({
    start: match.index!, end: match.index! + match[0].length, label: match[1]!, type: match[2] as "attachment" | "note" | "session", id: match[3]!, source: match[0],
  }));
}
export function referenceSource(label: string, id: string, type: "attachment" | "note" | "session"): string {
  return `@[${label.replace(/\]/g, "］").replace(/\n/g, " ")}](brigadier-${type}:${id})`;
}
