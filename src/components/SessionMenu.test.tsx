import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionMenu } from "./SessionMenu";
import { navigationApi, emptyNavigation } from "../navigationApi";
import { useSessionNavigation } from "../sessionNavigation";
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigationApi, "load").mockResolvedValue(emptyNavigation);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function State() {
  const state = useSessionNavigation();
  return <output>{JSON.stringify(state)}</output>;
}
describe("session header menu", () => {
  it("renames persistently, archives, and synchronizes other views", async () => {
    const user = userEvent.setup(),
      archive = vi.fn();
    render(
      <>
        <SessionMenu
          sessionId="s"
          title="Original"
          canFork
          onArchive={archive}
        />
        <State />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(
      screen
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label") ?? item.textContent),
    ).toEqual(["Rename", "Pin", "Archive", "Fork"]);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Session name"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("Session name"), "Renamed session");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("status")).toHaveTextContent("Renamed session");
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(archive).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent('"archivedIds":[]');
  });
  it("pins using the existing API and invokes a fork only on activation", async () => {
    const user = userEvent.setup(),
      fork = vi.fn().mockResolvedValue(undefined);
    const pin = vi
      .spyOn(navigationApi, "customize")
      .mockResolvedValue(emptyNavigation);
    render(
      <SessionMenu
        sessionId="s"
        title="Original"
        canFork
        onFork={fork}
        onArchive={() => {}}
      />,
    );
    await user.hover(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(pin).toHaveBeenCalledWith("pin", "s", "pinned");
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Fork" }));
    expect(fork).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Fork session" }));
    await waitFor(() => expect(fork).toHaveBeenCalledWith(false));
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Fork" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Fork session in new worktree" }),
    );
    await waitFor(() => expect(fork).toHaveBeenLastCalledWith(true));
  });
});
