import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentTab } from "./DocumentTab";
import { workbenchApi } from "../workbenchApi";
vi.mock("./CodeEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="File editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const note = {
  id: "n",
  projectId: null,
  title: "Original",
  content: "disk text",
  revision: 1,
  language: "markdown",
  alwaysInclude: false,
};
const props = {
  tab: {
    id: "note:n",
    kind: "note" as const,
    path: "Original",
    context: { projectId: "p", sessionId: null },
    root: "/repo",
  },
  onNote: vi.fn(),
  onSaved: vi.fn(),
  onAttach: vi.fn(),
  refresh: vi.fn(),
};
describe("external note changes", () => {
  it("updates the title input after a sidebar or external rename", async () => {
    const save = vi.spyOn(workbenchApi, "saveNote");
    const view = render(<DocumentTab {...props} note={note} />);
    await screen.findByLabelText("File editor");
    view.rerender(
      <DocumentTab
        {...props}
        note={{ ...note, title: "Renamed", revision: 2 }}
      />,
    );
    expect(screen.getByLabelText("Note title")).toHaveValue("Renamed");
    fireEvent.blur(screen.getByLabelText("Note title"));
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps a recovered draft without overwriting newer disk content", async () => {
    localStorage.setItem(
      "brigadier:buffer:note:n",
      JSON.stringify({
        content: "my draft",
        before: "old disk text",
        language: "markdown",
      }),
    );
    const save = vi.spyOn(workbenchApi, "saveNote");
    render(<DocumentTab {...props} note={note} />);
    expect(await screen.findByLabelText("File editor")).toHaveValue("my draft");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(save).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Discard draft and reload from disk",
      }),
    );
    expect(screen.getByLabelText("File editor")).toHaveValue("disk text");
  });
});
