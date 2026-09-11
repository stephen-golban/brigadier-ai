import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip, TooltipGroup } from "./tooltip";
import { Button } from "@/components/ui/button";
import { Kbd } from "./kbd";
afterEach(cleanup);

it("shares one hint across grouped controls and retains keyboard and pointer access", async () => {
  const user = userEvent.setup();
  render(<TooltipGroup>
    <Tooltip content="Pin this session"><Button aria-label="Pin">Pin</Button></Tooltip>
    <Tooltip content="Archive this session"><Button aria-label="Archive">Archive</Button></Tooltip>
  </TooltipGroup>);
  const pin = screen.getByRole("button", {name: "Pin"});
  const archive = screen.getByRole("button", {name: "Archive"});
  await user.hover(pin);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Pin this session");
  await user.hover(archive);
  await waitFor(() => expect(screen.getAllByRole("tooltip")).toHaveLength(1));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Archive this session");
  await user.hover(screen.getByRole("tooltip"));
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  await user.unhover(screen.getByRole("tooltip"));
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  await user.tab();
  expect(pin).toHaveFocus();
  expect(pin).toHaveAccessibleDescription("Pin this session");
  await user.tab();
  expect(archive).toHaveFocus();
  expect(archive).toHaveAccessibleDescription("Archive this session");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(archive).toHaveFocus();
});

it("shows the shortcut on focus, dismisses with Escape, and preserves activation", async () => {
  const user = userEvent.setup();
  const search = vi.fn();
  render(
    <Tooltip
      content={
        <>
          Search <Kbd>⌘K</Kbd>
        </>
      }
    >
      <Button variant="ghost" size="sm" aria-label="Search" onClick={search}>
        Icon
      </Button>
    </Tooltip>,
  );
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole("tooltip")).toHaveTextContent("Search ⌘K");
  expect(
    screen.getByRole("button", { name: "Search" }),
  ).toHaveAccessibleDescription("Search ⌘K");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Search" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(search).toHaveBeenCalledOnce();
});
it("allows the pointer to enter the tooltip and dismisses when it leaves", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="Search">
      <Button variant="ghost" size="sm" aria-label="Search">Icon</Button>
    </Tooltip>,
  );
  await user.hover(screen.getByRole("button", { name: "Search" }));
  const hint = screen.getByRole("tooltip");
  await user.hover(hint);
  expect(hint).toBeInTheDocument();
  await user.unhover(hint);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
});

it("shows full text only when its visible label is truncated, including keyboard focus", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip
      content="Full session title"
      onlyWhenTruncated=".label"
      placement="right"
    >
      <Button variant="ghost" size="sm">
        <span className="label">Full session title</span>
      </Button>
    </Tooltip>,
  );
  const label = screen.getByText("Full session title");
  const button = screen.getByRole("button");
  const width = vi.spyOn(label, "clientWidth", "get").mockReturnValue(200);
  vi.spyOn(label, "scrollWidth", "get").mockReturnValue(150);
  await user.hover(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.unhover(button);
  width.mockReturnValue(80);
  await user.hover(button);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Full session title");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole("tooltip")).toHaveTextContent("Full session title");
});
