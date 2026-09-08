import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar, SidebarProvider } from "./sidebar";
afterEach(cleanup);
function Example({ attention = false }: { attention?: boolean }) {
  return (
    <SidebarProvider
      defaultOpen={false}
      attention={attention}
      navigationControls={<span>Navigation history</span>}
    >
      <Sidebar aria-label="Navigation">
        <button>Inside navigation</button>
      </Sidebar>
      <main>Selected chat</main>
    </SidebarProvider>
  );
}
it("previews the collapsed sidebar on hover without pinning it, and closes on leave", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const toggle = screen.getByRole("button", { name: "Toggle Sidebar" });
  expect(
    screen.queryByRole("button", { name: "Inside navigation" }),
  ).not.toBeInTheDocument();
  await user.hover(toggle);
  const inside = await screen.findByRole("button", {
    name: "Inside navigation",
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(inside.closest('[data-slot="sidebar-shell"]')).toHaveAttribute(
    "data-open",
    "false",
  );
  await user.hover(inside);
  await user.unhover(inside);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Inside navigation" }),
    ).not.toBeInTheDocument(),
  );
});
it("pins a preview with a click and shows attention only while collapsed", async () => {
  const user = userEvent.setup();
  render(<Example attention />);
  expect(
    screen.getByRole("img", { name: "Sessions need attention" }),
  ).toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Toggle Sidebar" });
  await user.hover(toggle);
  await screen.findByRole("button", { name: "Inside navigation" });
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Navigation history")).toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: "Sessions need attention" }),
  ).not.toBeInTheDocument();
  await user.click(toggle);
  expect(screen.getByText("Selected chat")).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Sessions need attention" }),
  ).toBeInTheDocument();
});
it("dismisses a preview with Escape and dispatches new chat from the collapsed toolbar", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.hover(screen.getByRole("button", { name: "Toggle Sidebar" }));
  await screen.findByRole("button", { name: "Inside navigation" });
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("button", { name: "Inside navigation" }),
  ).not.toBeInTheDocument();
  const create = vi.fn();
  window.addEventListener("brigadier-new-chat", create);
  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(create).toHaveBeenCalledOnce();
  window.removeEventListener("brigadier-new-chat", create);
});
