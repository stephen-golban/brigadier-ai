// assistant-ui Markdown's syntax-highlighter extension, backed by Shiki.
import { themeColor } from "../../../lib/theme";
import { useEffect, useState } from "react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { codeToTokens, bundledLanguages } from "shiki/bundle/web";
import type { ThemedToken } from "shiki";
export function SyntaxHighlighter({
  code,
  language,
  components: { Pre, Code },
}: SyntaxHighlighterProps) {
  const [highlight, setHighlight] = useState<{
    code: string;
    language: string;
    tokens: ThemedToken[][];
  } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() =>
        codeToTokens(code, {
          lang:
            language in bundledLanguages
              ? (language as keyof typeof bundledLanguages)
              : "text",
          theme: {
            name: "brigadier",
            type: "dark",
            fg: themeColor("text"),
            bg: themeColor("elevated"),
            settings: [
              {
                scope: ["comment", "punctuation.definition.comment"],
                settings: {
                  foreground: themeColor("text-tertiary"),
                  fontStyle: "italic",
                },
              },
              {
                scope: ["string", "constant"],
                settings: { foreground: themeColor("text-secondary") },
              },
              {
                scope: ["keyword", "storage"],
                settings: { foreground: themeColor("text"), fontStyle: "bold" },
              },
            ],
          },
        }),
      )
      .then((result) => {
        if (live) setHighlight({ code, language, tokens: result.tokens });
      })
      .catch(() => {
        if (live) setHighlight(null);
      });
    return () => {
      live = false;
    };
  }, [code, language]);
  const tokens =
    highlight?.code === code && highlight.language === language
      ? highlight.tokens
      : null;
  return (
    <Pre className="aui-highlight overflow-x-auto bg-elevated font-mono text-[13px] leading-relaxed">
      <Code>
        {tokens
          ? tokens.map((line, index) => (
              <span className="line" key={index}>
                {line.map((token, i) => (
                  <span key={i} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {index < tokens.length - 1 ? "\n" : null}
              </span>
            ))
          : code}
      </Code>
    </Pre>
  );
}
