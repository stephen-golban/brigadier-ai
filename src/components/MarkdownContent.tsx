import { Button } from "./controls/button";
import { memo, useRef } from "react";
import { defaultUrlTransform } from "react-markdown";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { MarkdownText } from "./assistant-ui/elements/markdown-text";
function MarkdownContent({
  text,
  onFile,
}: {
  text: string;
  onFile?: (path: string) => void;
}) {
  const fileHandler = useRef(onFile);
  fileHandler.current = onFile;
  return (
    <TextMessagePartProvider text={text}>
      <MarkdownText
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
                <Button
                  className="file-link inline h-auto p-0 text-text underline underline-offset-2"
                  onClick={() => {
                    let path = href.replace(/^\.\//, "");
                    try {
                      path = decodeURIComponent(path);
                    } catch {
                      /* Keep a literal filename containing an incomplete escape. */
                    }
                    fileHandler.current?.(path);
                  }}
                >
                  {children}
                </Button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      />
    </TextMessagePartProvider>
  );
}

export default memo(MarkdownContent);
