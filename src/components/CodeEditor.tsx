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
monaco.editor.defineTheme("brigadier", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#181818",
    "editor.lineHighlightBackground": "#222222",
    "editorGutter.background": "#181818",
    "editorLineNumber.foreground": "#666666",
    "editor.selectionBackground": "#3e4a56",
    "editorWidget.background": "#252525",
  },
});
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
    const model = monaco.editor.createModel(
      value,
      language,
      monaco.Uri.parse(`inmemory://brigadier/${encodeURIComponent(id)}`),
    );
    const instance = monaco.editor.create(host.current, {
      model,
      editContext: false,
      theme: "brigadier",
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
  return <div ref={host} className="code-editor" />;
}
