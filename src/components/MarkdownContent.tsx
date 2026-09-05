import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
function MarkdownContent({
  text,
  onFile,
}: {
  text: string;
  onFile?: (path: string) => void;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          url.startsWith("/") || url.startsWith("./")
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) => {
            if (
              href &&
              !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
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
          pre: ({ children }) => <pre>{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownContent);
