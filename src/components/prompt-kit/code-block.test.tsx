import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CodeBlockCode } from "./code-block";
import { codeToHtml } from "shiki/bundle/web";

vi.mock("shiki/bundle/web", () => ({
  bundledLanguages: { typescript: {} },
  codeToHtml: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("falls back to plain text for unknown languages and failed highlighting", async () => {
  vi.mocked(codeToHtml).mockRejectedValue(new Error("Unknown theme"));
  render(
    <CodeBlockCode
      code="<script>literal</script>"
      language="custom-language"
    />,
  );
  await waitFor(() =>
    expect(codeToHtml).toHaveBeenCalledWith("<script>literal</script>", {
      lang: "text",
      theme: "github-dark",
    }),
  );
  expect(screen.getByText("<script>literal</script>")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
});

it("does not replace new streamed code with a late highlight of old code", async () => {
  let finishOld!: (html: string) => void;
  vi.mocked(codeToHtml)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce("<pre><code>new code</code></pre>");
  const view = render(<CodeBlockCode code="old code" language="typescript" />);
  view.rerender(<CodeBlockCode code="new code" language="typescript" />);
  await waitFor(() => expect(screen.getByText("new code")).toBeVisible());
  finishOld("<pre><code>old code</code></pre>");
  await waitFor(() =>
    expect(screen.queryByText("old code")).not.toBeInTheDocument(),
  );
});
