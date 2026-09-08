import { editorColor } from "../lib/theme";
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "json"
      ? new JsonWorker()
      : ["css", "scss", "less"].includes(label)
        ? new CssWorker()
        : ["html", "handlebars", "razor"].includes(label)
          ? new HtmlWorker()
          : ["typescript", "javascript"].includes(label)
            ? new TsWorker()
            : new EditorWorker(),
};
function installEditorTheme() {
  const text = editorColor("text"),
    secondary = editorColor("text-secondary"),
    canvas = editorColor("canvas"),
    elevated = editorColor("elevated"),
    selected = editorColor("selected"),
    line = editorColor("hairline");
  monaco.editor.defineTheme("brigadier", {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: text.slice(1) },
      {
        token: "comment",
        foreground: editorColor("text-tertiary").slice(1),
        fontStyle: "italic",
      },
      { token: "string", foreground: secondary.slice(1) },
    ],
    colors: {
      foreground: text,
      focusBorder: secondary,
      "editor.background": canvas,
      "editor.foreground": text,
      "editor.lineHighlightBackground": editorColor("hover"),
      "editorGutter.background": canvas,
      "editorLineNumber.foreground": editorColor("text-tertiary"),
      "editorLineNumber.activeForeground": secondary,
      "editor.selectionBackground": selected,
      "editor.inactiveSelectionBackground": selected,
      "editor.selectionHighlightBackground": selected,
      "editor.wordHighlightBackground": selected,
      "editor.wordHighlightStrongBackground": selected,
      "editor.findMatchBackground": selected,
      "editor.findMatchHighlightBackground": selected,
      "editorCursor.foreground": text,
      "editorWidget.background": elevated,
      "editorWidget.foreground": text,
      "editorWidget.border": line,
      "editorSuggestWidget.background": elevated,
      "editorSuggestWidget.foreground": text,
      "editorSuggestWidget.selectedBackground": selected,
      "editorSuggestWidget.highlightForeground": text,
      "editorSuggestWidget.focusHighlightForeground": text,
      "editorSuggestWidget.border": line,
      "editorHoverWidget.background": elevated,
      "editorHoverWidget.foreground": text,
      "editorHoverWidget.border": line,
      "editorHoverWidget.statusBarBackground": elevated,
      "list.activeSelectionBackground": selected,
      "list.activeSelectionForeground": text,
      "list.inactiveSelectionBackground": selected,
      "list.focusBackground": selected,
      "list.hoverBackground": editorColor("hover"),
      "list.highlightForeground": text,
      "input.background": editorColor("input"),
      "input.foreground": text,
      "input.border": line,
      "inputOption.activeBackground": selected,
      "inputOption.activeBorder": secondary,
      "button.background": selected,
      "button.foreground": text,
      "button.hoverBackground": editorColor("hover"),
      "textLink.foreground": text,
      "textLink.activeForeground": text,
      "scrollbarSlider.background": selected,
      "scrollbarSlider.hoverBackground": selected,
      "scrollbarSlider.activeBackground": selected,
      "editorError.foreground": editorColor("error"),
      "editorWarning.foreground": editorColor("warn"),
      "editorInfo.foreground": secondary,
      "editorHint.foreground": secondary,
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          `editorBracketHighlight.foreground${index + 1}`,
          secondary,
        ]),
      ),
    },
  });
}
const views = new Map<string, monaco.editor.ICodeEditorViewState>();
export const languages = [
  "plaintext",
  "markdown",
  "typescript",
  "javascript",
  "json",
  "css",
  "html",
  "rust",
  "python",
  "shell",
  "yaml",
  "sql",
];
export function languageFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        css: "css",
        html: "html",
        md: "markdown",
        rs: "rust",
        py: "python",
        sh: "shell",
        yml: "yaml",
        yaml: "yaml",
        sql: "sql",
      } as Record<string, string>
    )[ext ?? ""] ?? "plaintext"
  );
}
export default function CodeEditor({
  id,
  value,
  language,
  onChange,
  onSave,
  line,
  readOnly = false,
  onSelection,
}: {
  id: string;
  value: string;
  language: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  line?: number;
  readOnly?: boolean;
  onSelection?: (start: number, end: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onSave, onSelection });
  callbacks.current = { onChange, onSave, onSelection };
  useEffect(() => {
    if (!host.current) return;
    installEditorTheme();
    const model = monaco.editor.createModel(
      value,
      language,
      monaco.Uri.parse(`inmemory://brigadier/${encodeURIComponent(id)}`),
    );
    const instance = monaco.editor.create(host.current, {
      model,
      editContext: false,
      theme: "brigadier",
      cursorBlinking: "solid",
      smoothScrolling: false,
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "SFMono-Regular, Menlo, monospace",
      minimap: { enabled: false },
      padding: { top: 16 },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      readOnly,
      ariaLabel: "File editor",
      fixedOverflowWidgets: true,
    });
    editor.current = instance;
    const previous = views.get(id);
    if (previous) instance.restoreViewState(previous);
    const changed = instance.onDidChangeModelContent(() =>
      callbacks.current.onChange(instance.getValue()),
    );
    const selection = instance.onDidChangeCursorSelection((e) =>
      callbacks.current.onSelection?.(
        e.selection.startLineNumber,
        e.selection.endLineNumber,
      ),
    );
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      callbacks.current.onSave?.(),
    );
    return () => {
      const state = instance.saveViewState();
      if (state) views.set(id, state);
      changed.dispose();
      selection.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, [id]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);
  useEffect(() => {
    if (line && editor.current) {
      editor.current.revealLineInCenter(line);
      editor.current.setPosition({ lineNumber: line, column: 1 });
    }
  }, [line, id]);
  return <div ref={host} className="code-editor h-full min-h-0" />;
}
