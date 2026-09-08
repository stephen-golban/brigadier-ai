import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SyntaxHighlighter } from "./syntax-highlighter";
import { codeToTokens } from "shiki/bundle/web";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
vi.mock("../../../lib/theme", () => ({ themeColor: () => "currentColor" }));
vi.mock("shiki/bundle/web", () => ({
  bundledLanguages: { typescript: {} },
  codeToTokens: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const components: SyntaxHighlighterProps["components"] = {
  Pre: (props) => <pre {...props} />,
  Code: (props) => <code {...props} />,
};
it("keeps unknown languages and highlighting failures safe and readable", async () => {
  vi.mocked(codeToTokens).mockRejectedValue(new Error("Highlighting failed"));
  render(
    <SyntaxHighlighter
      code="<script>literal</script>"
      language="unknown"
      components={components}
    />,
  );
  await waitFor(() =>
    expect(codeToTokens).toHaveBeenCalledWith(
      "<script>literal</script>",
      expect.objectContaining({ lang: "text" }),
    ),
  );
  expect(screen.getByText("<script>literal</script>")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
});
it("ignores late highlighting results after streamed code changes", async () => {
  type Result = Awaited<ReturnType<typeof codeToTokens>>;
  let finish!: (value: Result) => void;
  vi.mocked(codeToTokens)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("use fallback"));
  const view = render(
    <SyntaxHighlighter
      code="old"
      language="typescript"
      components={components}
    />,
  );
  view.rerender(
    <SyntaxHighlighter
      code="new"
      language="typescript"
      components={components}
    />,
  );
  await waitFor(() => expect(codeToTokens).toHaveBeenCalledTimes(2));
  finish({ tokens: [[{ content: "old", offset: 0, color: "red" }]] } as Result);
  await waitFor(() => expect(screen.getByText("new")).toBeVisible());
  expect(screen.queryByText("old")).not.toBeInTheDocument();
});
