import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchDialog } from "./search-dialog";
afterEach(cleanup);
describe("command search", () => {
  it("filters groups, navigates with arrows while retaining input focus, and activates the selected result", async () => {
    const user = userEvent.setup();
    const first = vi.fn(),
      second = vi.fn();
    render(
      <SearchDialog
        open
        onOpenChange={() => {}}
        groups={[
          {
            label: "Projects",
            items: [
              {
                id: "alpha",
                search: "Alpha project",
                content: "Alpha",
                onSelect: first,
              },
              {
                id: "beta",
                search: "Beta project",
                content: "Beta",
                onSelect: second,
              },
            ],
          },
        ]}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "project");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveFocus();
    expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Enter}");
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "missing");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("No results found.");
  });
});
