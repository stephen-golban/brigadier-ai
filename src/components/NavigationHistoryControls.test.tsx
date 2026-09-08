import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { NavigationHistoryControls } from "./NavigationHistoryControls";
afterEach(cleanup);
function Host() {
  const [sessionId, setSession] = useState("a");
  return (
    <>
      <NavigationHistoryControls
        projectId="p"
        sessionId={sessionId}
        isAvailable={() => true}
        onNavigate={(location) => setSession(location.sessionId!)}
      />
      <span data-testid="current">{sessionId}</span>
      <button onClick={() => setSession("b")}>Open B</button>
      <button onClick={() => setSession("c")}>Open C</button>
    </>
  );
}
it("navigates back/forward and discards forward history on a new selection", async () => {
  const user = userEvent.setup();
  render(<Host />);
  expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Open B" }));
  await user.click(screen.getByRole("button", { name: "Go back" }));
  expect(screen.getByTestId("current")).toHaveTextContent("a");
  await user.click(screen.getByRole("button", { name: "Go forward" }));
  expect(screen.getByTestId("current")).toHaveTextContent("b");
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await user.click(screen.getByRole("button", { name: "Open C" }));
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
});
it("skips locations whose project or session is no longer available", async () => {
  const user = userEvent.setup();
  const navigate = vi.fn();
  const available = (location: { sessionId: string | null }) =>
    location.sessionId !== "b";
  const view = render(
    <NavigationHistoryControls
      projectId="p"
      sessionId="a"
      isAvailable={available}
      onNavigate={navigate}
    />,
  );
  view.rerender(
    <NavigationHistoryControls
      projectId="p"
      sessionId="b"
      isAvailable={available}
      onNavigate={navigate}
    />,
  );
  view.rerender(
    <NavigationHistoryControls
      projectId="p"
      sessionId="c"
      isAvailable={available}
      onNavigate={navigate}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Go back" }));
  expect(navigate).toHaveBeenCalledWith({ projectId: "p", sessionId: "a" });
});
it("records the Notepad page and waits for unsaved-change resolution before moving history", async () => {
  const user = userEvent.setup();
  const navigate = vi.fn();
  let proceed: (() => void) | undefined;
  const props = {
    projectId: "p",
    sessionId: null,
    isAvailable: () => true,
    onNavigate: navigate,
    beforeNavigate: (next: () => void) => {
      proceed = next;
    },
  };
  const view = render(
    <NavigationHistoryControls {...props} page="workspace" />,
  );
  view.rerender(<NavigationHistoryControls {...props} page="notepad" />);
  await user.click(screen.getByRole("button", { name: "Go back" }));
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
  await act(async () => proceed?.());
  expect(navigate).toHaveBeenCalledWith({
    projectId: "p",
    sessionId: null,
    page: "workspace",
  });
  expect(screen.getByRole("button", { name: "Go forward" })).toBeEnabled();
});
