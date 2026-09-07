import { memo } from "react";
import { defaultUrlTransform } from "react-markdown";
import { Markdown as KitMarkdown } from "./prompt-kit/markdown";
function MarkdownContent({
  text,
  onFile,
}: {
  text: string;
  onFile?: (path: string) => void;
}) {
  return (
    <KitMarkdown
      urlTransform={(url) =>
        url.startsWith("/") ||
        url.startsWith("./") ||
        /^brigadier-note:[a-zA-Z0-9_-]+$/.test(url)
          ? url
          : defaultUrlTransform(url)
      }
      components={{
        a: ({ href, children }) => {
          if (
            href &&
            (!/^[a-z][a-z0-9+.-]*:/i.test(href) ||
              /^brigadier-note:[a-zA-Z0-9_-]+$/.test(href)) &&
            !href.startsWith("//") &&
            !href.startsWith("#")
          ) {
            return (
              <button
                className="file-link"
                onClick={() => {
                  let path = href.replace(/^\.\//, "");
                  try {
                    path = decodeURIComponent(path);
                  } catch {
                    /* Keep a literal filename containing an incomplete escape. */
                  }
                  onFile?.(path);
                }}
              >
                {children}
              </button>
            );
          }
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </KitMarkdown>
  );
}

export default memo(MarkdownContent);
