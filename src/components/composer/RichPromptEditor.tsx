/** Isolates assistant-ui's pinned Lexical integration from durable composer state. */
import { useEffect, useMemo, useRef, useState, useImperativeHandle, useId, Fragment, type Ref, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeNode } from "@lexical/code";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { $convertFromMarkdownString, TRANSFORMERS, type TextMatchTransformer } from "@lexical/markdown";
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode,
  $getNodeByKey, $createRangeSelection, $setSelection, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ESCAPE_COMMAND, KEY_TAB_COMMAND, PASTE_COMMAND,
  CLEAR_HISTORY_COMMAND, FORMAT_TEXT_COMMAND, HISTORY_PUSH_TAG, type TextFormatType,
} from "lexical";
import { $createDirectiveNode, DirectiveNode, DirectiveChipProvider } from "@assistant-ui/react-lexical";
import { $editorSource, referenceTokens } from "./editorSource";
import "./composer.css";

export interface EditorSuggestion { id: string; label: string; description?: string; kind: "file" | "note" | "session" | "command" }
export interface EditorHandle { focus(): void; insert(text: string): void; format(format: TextFormatType): void }
export interface RichPromptEditorProps {
  value: string;
  onText(value: string): void;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  focusKey?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  search?: (kind: "@" | "/", query: string) => Promise<EditorSuggestion[]>;
  select?: (item: EditorSuggestion) => Promise<string>;
  onError?: (message: string) => void;
  editorRef?: Ref<EditorHandle>;
}
interface Trigger { key: string; start: number; end: number; source: string; kind: "@" | "/"; query: string }
const referenceTransformer: TextMatchTransformer = {
  dependencies: [DirectiveNode], type: "text-match", trigger: ")",
  importRegExp: /@\[([^\]\n]*)\]\(brigadier-(attachment|note|session):([^\s)]+)\)/,
  regExp: /@\[([^\]\n]*)\]\(brigadier-(attachment|note|session):([^\s)]+)\)$/,
  replace: (node, match) => { node.replace($createDirectiveNode({ id: match[3]!, type: match[2]!, label: match[1]! }, match[0])); },
};
const shortcuts = [referenceTransformer, ...TRANSFORMERS];

function appendLiteral(text: string) {
  if (text) {
    $convertFromMarkdownString(text, shortcuts);
    if ($editorSource() === text) return;
  }
  const root = $getRoot();
  root.clear();
  // Stored source remains literal. Do not run a Markdown parser over shell paths/code on reload.
  for (const line of text.split("\n")) {
    const paragraph = $createParagraphNode();
    let offset = 0;
    for (const token of referenceTokens(line)) {
      if (token.start > offset) paragraph.append($createTextNode(line.slice(offset, token.start)));
      paragraph.append($createDirectiveNode({ id: token.id, type: token.type, label: token.label }, token.source));
      offset = token.end;
    }
    if (offset < line.length) paragraph.append($createTextNode(line.slice(offset)));
    root.append(paragraph);
  }
}
export function RichPromptEditor(props: RichPromptEditorProps) {
  const initialConfig = useMemo(() => ({
    namespace: "brigadier-prompt", editable: !props.disabled,
    nodes: [DirectiveNode, HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
    theme: {
      paragraph: "prompt-paragraph", heading: { h1: "prompt-heading", h2: "prompt-heading", h3: "prompt-heading" },
      text: { bold: "prompt-bold", italic: "prompt-italic", code: "prompt-code", strikethrough: "prompt-strike" },
      code: "prompt-code-block", quote: "prompt-quote", list: { ul: "prompt-ul", ol: "prompt-ol", listitem: "prompt-li" },
    },
    onError: (error: Error) => props.onError?.(error.message),
    editorState: () => appendLiteral(props.value),
  // The outer PromptInput key identifies the draft; controlled updates go through Bridge.
  }), []);
  return <LexicalComposer initialConfig={initialConfig}>
    <DirectiveChipProvider value={null}>
      <div className="brigadier-rich-editor" onClickCapture={event => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); }}>
        <RichTextPlugin contentEditable={<ContentEditable className="brigadier-rich-input" aria-label={props.label ?? "Message"} aria-multiline="true" spellCheck role="textbox" />} placeholder={<div className="brigadier-rich-placeholder">{props.placeholder}</div>} ErrorBoundary={LexicalErrorBoundary} />
        <HistoryPlugin />
        <ListPlugin />
        <MarkdownShortcutPlugin transformers={shortcuts} />
        <Bridge {...props} />
      </div>
    </DirectiveChipProvider>
  </LexicalComposer>;
}
function Bridge(props: RichPromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const menuId = useId();
  const latest = useRef(props); latest.current = props;
  const lastSource = useRef(props.value);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const activeTrigger = useRef<Trigger | null>(null);
  const [items, setItems] = useState<EditorSuggestion[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const selecting = useRef(false);
  const menu = useRef({ items, index }); menu.current = { items, index };
  const updateTrigger = (next: Trigger | null) => {
    if (JSON.stringify(next) === JSON.stringify(activeTrigger.current)) return;
    activeTrigger.current = next; setTrigger(next);
  };
  useEffect(() => { editor.setEditable(!props.disabled); }, [editor, props.disabled]);
  useEffect(() => {
    if (props.value === lastSource.current) return;
    lastSource.current = props.value;
    editor.update(() => { appendLiteral(props.value); $getRoot().selectEnd(); }, { tag: "brigadier-external" });
    // External draft/session resets must not undo into a previous conversation.
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    updateTrigger(null);
  }, [editor, props.value]);
  useEffect(() => { if (props.focusKey && !props.disabled) { editor.update(() => $getRoot().selectEnd(), { tag: "brigadier-focus" }); editor.focus(undefined, { defaultSelection: "rootEnd" }); editor.getRootElement()?.focus(); } }, [editor, props.focusKey, props.disabled]);
  useImperativeHandle(props.editorRef, () => ({
    focus: () => editor.focus(),
    insert: text => { editor.update(() => {
      const current = $getSelection();
      const selection = $isRangeSelection(current) ? current : $getRoot().selectEnd();
      const tokens = referenceTokens(text.trim());
      if (tokens.length === 1 && tokens[0]!.source === text.trim()) {
        const token = tokens[0]!;
        selection.insertNodes([$createDirectiveNode({ id: token.id, type: token.type, label: token.label }, token.source), $createTextNode(" ")]);
      } else selection.insertText(text);
    }, { tag: HISTORY_PUSH_TAG }); editor.focus(); },
    format: format => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, format); editor.focus(); },
  }), [editor]);
  useEffect(() => editor.registerUpdateListener(({ editorState, tags }) => {
    editorState.read(() => {
      if (!tags.has("brigadier-external")) {
        const text = $editorSource();
        if (text !== lastSource.current) { lastSource.current = text; latest.current.onText(text); }
      }
      const selection = $getSelection();
      if (!latest.current.search) { updateTrigger(null); return; }
      if (!$isRangeSelection(selection) || !selection.isCollapsed() || editor.isComposing()) { updateTrigger(null); return; }
      const node = selection.anchor.getNode();
      if (!$isTextNode(node) || node.hasFormat("code") || node.getParent()?.getType() === "code") { updateTrigger(null); return; }
      const before = node.getTextContent().slice(0, selection.anchor.offset);
      const match = /(?:^|\s)(@)([^\s@]*)$/.exec(before) ?? /(?:^|\s)(\/)([^\s@/]*)$/.exec(before);
      if (!match || (match[1] === "/" && $editorSource().slice(0, selection.anchor.offset) !== before)) { updateTrigger(null); return; }
      const source = `${match[1]}${match[2]}`;
      updateTrigger({ key: node.getKey(), start: before.length - source.length, end: before.length, kind: match[1] as "@" | "/", query: match[2]!, source });
    });
  }), [editor]);
  useEffect(() => {
    let cancelled = false;
    setItems([]); setIndex(0);
    if (!trigger || !props.search) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void props.search!(trigger.kind, trigger.query).then(result => { if (!cancelled) setItems(result.slice(0, 24)); }).catch(error => { if (!cancelled) latest.current.onError?.(String(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [trigger, props.search]);
  const choose = async (item: EditorSuggestion) => {
    const captured = activeTrigger.current;
    if (!captured || selecting.current || !latest.current.select) return;
    selecting.current = true;
    try {
      const source = await latest.current.select(item);
      if (JSON.stringify(captured) !== JSON.stringify(activeTrigger.current) || latest.current.disabled) return;
      editor.update(() => {
        const node = $getNodeByKey(captured.key);
        if (!$isTextNode(node) || node.getTextContent().slice(captured.start, captured.end) !== captured.source) return;
        const selection = $createRangeSelection();
        selection.setTextNodeRange(node, captured.start, node, captured.end); $setSelection(selection);
        const tokens = referenceTokens(source.trim());
        if (tokens.length === 1 && tokens[0]!.source === source.trim()) {
          const token = tokens[0]!;
          selection.insertNodes([$createDirectiveNode({ id: token.id, type: token.type, label: token.label }, token.source), $createTextNode(" ")]);
        } else selection.insertText(source);
      }, { tag: HISTORY_PUSH_TAG });
      updateTrigger(null); editor.focus();
    } catch (error) { latest.current.onError?.(error instanceof Error ? error.message : String(error)); }
    finally { selecting.current = false; }
  };
  const selectLatest = useRef(choose); selectLatest.current = choose;
  useEffect(() => {
    const unregister = [
      editor.registerCommand(KEY_ENTER_COMMAND, event => {
        if (!event) return false;
        if (event.isComposing || editor.isComposing()) return true;
        if (activeTrigger.current && !event.shiftKey) { event.preventDefault(); if (menu.current.items.length) void selectLatest.current(menu.current.items[menu.current.index]!); return true; }
        const callback = latest.current.onKeyDown;
        if (!callback) return false;
        callback({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, nativeEvent: event, preventDefault: () => event.preventDefault() } as ReactKeyboardEvent<HTMLElement>);
        return event.defaultPrevented;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, event => { if (!activeTrigger.current || !menu.current.items.length) return false; event.preventDefault(); setIndex(value => (value + 1) % menu.current.items.length); return true; }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, event => { if (!activeTrigger.current || !menu.current.items.length) return false; event.preventDefault(); setIndex(value => (value + menu.current.items.length - 1) % menu.current.items.length); return true; }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => { if (!activeTrigger.current) return false; event.preventDefault(); updateTrigger(null); return true; }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_TAB_COMMAND, event => { if (!activeTrigger.current || !menu.current.items.length) return false; event.preventDefault(); void selectLatest.current(menu.current.items[menu.current.index]!); return true; }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(PASTE_COMMAND, event => {
        if (!event || !("clipboardData" in event) || !event.clipboardData || event.clipboardData.files.length) return false;
        const text = event.clipboardData.getData("text/plain");
        event.preventDefault(); const selection = $getSelection(); if ($isRangeSelection(selection)) selection.insertRawText(text); return true;
      }, COMMAND_PRIORITY_HIGH),
    ];
    return () => unregister.forEach(dispose => dispose());
  }, [editor]);
  useEffect(() => {
    const element = editor.getRootElement();
    if (!element) return;
    element.setAttribute("aria-autocomplete", "list");
    if (trigger) { element.setAttribute("aria-controls", menuId); element.setAttribute("aria-expanded", "true"); }
    else { element.removeAttribute("aria-controls"); element.setAttribute("aria-expanded", "false"); }
    if (trigger && items[index]) {
      element.setAttribute("aria-activedescendant", `${menuId}-option-${index}`);
      document.getElementById(`${menuId}-option-${index}`)?.scrollIntoView({ block: "nearest" });
    }
    else element.removeAttribute("aria-activedescendant");
  }, [editor, trigger, items, index, menuId]);
  return trigger ? <div className="composer-suggestions" onMouseDown={event => event.preventDefault()}>
    <div className="composer-suggestion-heading">{trigger.kind === "@" ? "Reference a file, note or agent session" : "Supported commands · select to insert"}</div>
    <div role="listbox" aria-label={trigger.kind === "@" ? "References" : "Commands"} id={menuId}>
      {items.map((item, itemIndex) => <Fragment key={`${item.kind}:${item.id}`}>{trigger.kind === "@" && (itemIndex === 0 || items[itemIndex - 1]?.kind !== item.kind) && <div className="composer-suggestion-heading" role="presentation">{item.kind === "file" ? "Files" : item.kind === "note" ? "Notes" : "Agent sessions"}</div>}<button type="button" role="option" aria-selected={index === itemIndex} id={`${menuId}-option-${itemIndex}`} key={`${item.kind}:${item.id}`} onClick={() => void choose(item)}><span>{item.kind === "command" ? "/" : "@"}{item.label}</span>{item.description && <small>{item.description}</small>}</button></Fragment>)}
    </div>
    {!items.length && <p role="status">{loading ? "Searching…" : trigger.kind === "/" ? "No supported command matches" : "No matching files, notes or agent sessions"}</p>}
  </div> : null;
}
