import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memo, useEffect } from "react";
import { useSidebar as useKitSidebar } from "../ui/sidebar";
import { afterEach, expect, it, vi } from "vitest";
import {
  Sidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "./sidebar";
afterEach(cleanup);
// A fake-timer test that fails mid-flight must not leave the clock stopped for the next one.
afterEach(() => vi.useRealTimers());
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
/**
 * Hover intent (`PEEK_OPEN_DELAY_MS` in `./sidebar.tsx`, 300ms). Fake timers, because the point
 * of both tests is the boundary: at 200ms nothing has happened yet, at 300ms it has. They drive
 * the pointer with `fireEvent.pointerOver` / `pointerOut` rather than user-event: React derives
 * `onPointerEnter` / `onPointerLeave` from the over/out pair, and user-event's own awaits do not
 * survive `vi.useFakeTimers()`.
 */
function pointerOnToggle() {
  vi.useFakeTimers();
  render(<Example />);
  return screen.getByRole("button", { name: "Toggle Sidebar" });
}
const peeking = () =>
  screen.queryByRole("button", { name: "Inside navigation" }) !== null;
it("does not peek when the pointer only passes over the toggle", () => {
  const toggle = pointerOnToggle();
  fireEvent.pointerOver(toggle);
  act(() => vi.advanceTimersByTime(200));
  expect(peeking()).toBe(false);
  fireEvent.pointerOut(toggle, { relatedTarget: document.body });
  // Long past the 300ms the pointer never served: leaving cancelled the timer outright.
  act(() => vi.advanceTimersByTime(1000));
  expect(peeking()).toBe(false);
});
it("peeks once the pointer has rested on the toggle for 300ms", () => {
  const toggle = pointerOnToggle();
  fireEvent.pointerOver(toggle);
  act(() => vi.advanceTimersByTime(300));
  expect(peeking()).toBe(true);
  // A peek, not a pin.
  expect(toggle).toHaveAttribute("aria-expanded", "false");
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

/** `Sidebar.tsx` publishes the label; the chrome is the only place it is drawn. */
function Publish({ title }: { title: string }) {
  const { setCurrentSession } = useSidebar();
  useEffect(() => setCurrentSession(title), [setCurrentSession, title]);
  return null;
}
it("names the current session in the collapsed chrome and fades rather than ellipsises it", () => {
  render(
    <SidebarProvider defaultOpen={false}>
      <Publish title="Port the sidebar" />
      <Sidebar aria-label="Navigation" />
    </SidebarProvider>,
  );
  const label = screen.getByText("Port the sidebar");
  expect(label).toHaveClass("chrome-session-title", "text-fade-truncate");
  expect(label.closest(".workspace-chrome")).not.toBeNull();
});
it("carries the active row on a data attribute the Codex rules can select", () => {
  render(
    <SidebarProvider>
      <Sidebar aria-label="Navigation">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive>Selected chat</SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton>Other chat</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </Sidebar>
    </SidebarProvider>,
  );
  const active = screen.getByRole("button", { name: "Selected chat" });
  expect(active).toHaveClass("navigation-row");
  // `[data-active]:not([data-active="false"])` in `src/index.css` accepts either spelling; this
  // pins which one Base UI's `useRender` actually emits.
  expect(active.getAttribute("data-active")).not.toBe("false");
  expect(active).toHaveAttribute("data-active");
  expect(
    screen.getByRole("button", { name: "Other chat" }),
  ).not.toHaveAttribute("data-active");
});

it("keeps both sidebar contexts stable through unrelated parent updates", () => {
  const wrapper = vi.fn();
  const kit = vi.fn();
  const Probe = memo(function Probe() {
    wrapper(useSidebar());
    kit(useKitSidebar());
    return null;
  });
  const onOpenChange = vi.fn();
  const {rerender} = render(<SidebarProvider open onOpenChange={onOpenChange}><Probe/></SidebarProvider>);
  const beforeWrapper = wrapper.mock.calls[wrapper.mock.calls.length - 1]![0];
  const beforeKit = kit.mock.calls[kit.mock.calls.length - 1]![0];
  wrapper.mockClear(); kit.mockClear();
  rerender(<SidebarProvider open onOpenChange={onOpenChange}><Probe/></SidebarProvider>);
  expect(wrapper).not.toHaveBeenCalled();
  expect(kit).not.toHaveBeenCalled();
  rerender(<SidebarProvider open={false} onOpenChange={onOpenChange}><Probe/></SidebarProvider>);
  expect(wrapper.mock.calls[wrapper.mock.calls.length - 1]![0]).not.toBe(beforeWrapper);
  expect(kit.mock.calls[kit.mock.calls.length - 1]![0]).not.toBe(beforeKit);
  expect(wrapper.mock.calls[wrapper.mock.calls.length - 1]![0].open).toBe(false);
  expect(kit.mock.calls[kit.mock.calls.length - 1]![0].open).toBe(false);
});
