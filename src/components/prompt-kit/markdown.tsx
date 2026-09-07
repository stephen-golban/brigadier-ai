// Adapted from ibelick/prompt-kit (MIT). See THIRD_PARTY_NOTICES.md.
import { cn } from "@/lib/utils";
import { memo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockCode } from "./code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
  urlTransform?: Options["urlTransform"];
};

function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\S+)/);
  return match?.[1] ?? "plaintext";
}

// A pre node identifies a code block reliably, including one-line fences and
// multiline inline code. Source line positions do not distinguish those cases.
const INITIAL_COMPONENTS: Partial<Components> = {
  code: ({ className, children }) => (
    <code
      className={cn(
        "bg-secondary rounded-sm px-1 font-mono text-sm",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ node, children }) => {
    const codeNode = node?.children[0];
    if (codeNode?.type !== "element" || codeNode.tagName !== "code") {
      return <pre>{children}</pre>;
    }
    const code = codeNode.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    const classes = codeNode.properties.className;
    const language = extractLanguage(
      Array.isArray(classes) ? classes.join(" ") : String(classes ?? ""),
    );
    return (
      <CodeBlock>
        <CodeBlockCode code={code} language={language} />
      </CodeBlock>
    );
  },
};

function MarkdownComponent({
  children,
  className,
  components,
  ...props
}: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm prose-invert max-w-none min-w-0 break-words text-foreground prose-pre:p-0 prose-pre:bg-transparent prose-pre:whitespace-pre prose-code:before:content-none prose-code:after:content-none prose-table:block prose-table:overflow-x-auto",
        className,
      )}
    >
      <ReactMarkdown
        {...props}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{ ...INITIAL_COMPONENTS, ...components }}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";
export { Markdown };
