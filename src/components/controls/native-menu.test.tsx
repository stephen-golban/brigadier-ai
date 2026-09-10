import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({
  enabled: true,
  create: vi.fn(),
  submenu: vi.fn(),
  submenuClose: vi.fn(),
  popup: vi.fn(),
  close: vi.fn(),
  image: vi.fn(),
  imageClose: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => host.enabled }));
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: host.create },
  Submenu: { new: host.submenu },
}));
vi.mock("./native-menu-image", () => ({ nativeMenuImage: host.image }));
import { Dropdown, Label, Separator } from "./overlay";
import { DropdownContent } from "./menu";
import { Button } from "./button";
import { SidebarMenuAction } from "./sidebar";
import { Tooltip } from "./tooltip";

beforeEach(() => {
  host.enabled = true;
  host.submenuClose.mockReset().mockResolvedValue(undefined);
  host.submenu
    .mockReset()
    .mockResolvedValue({ rid: 11, kind: "Submenu", close: host.submenuClose });
  host.image.mockReset().mockResolvedValue({ rid: 9, close: host.imageClose });
  host.imageClose.mockReset().mockResolvedValue(undefined);
  host.create
    .mockReset()
    .mockImplementation(async () => ({ popup: host.popup, close: host.close }));
  host.popup.mockReset().mockResolvedValue(undefined);
  host.close.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Example({ action = () => {} }: { action?: () => void }) {
  return (
    <Dropdown native>
      <Button aria-label="Actions">•••</Button>
      <DropdownContent>
        <Dropdown.Item nativeIcon={<svg />} onAction={action}>
          <Label>Rename</Label>
        </Dropdown.Item>
        <Dropdown.Item isDisabled onAction={action}>
          Unavailable
        </Dropdown.Item>
        <Separator />
        <Dropdown.SubmenuTrigger>
          <Dropdown.Item>Project tag</Dropdown.Item>
          <DropdownContent>
            <Dropdown.Item checked textValue="Green tag" onAction={action}>
              Green
            </Dropdown.Item>
          </DropdownContent>
        </Dropdown.SubmenuTrigger>
      </DropdownContent>
    </Dropdown>
  );
}
it("uses native items, disabled states, separators, checked submenus, and the original actions", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(<Example action={action} />);
  await user.click(screen.getByRole("button", { name: "Actions" }));
  await waitFor(() => expect(host.close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  const items = host.create.mock.calls[0][0].items;
  expect(items[0].text).toBe("Rename");
  expect(items[0].icon.rid).toBe(9);
  expect(host.imageClose).toHaveBeenCalledOnce();
  expect(items[1].enabled).toBe(false);
  expect(items[2]).toEqual({ item: "Separator" });
  expect(items[3].items[0]).toMatchObject({ text: "Green tag", checked: true });
  items[0].action();
  expect(action).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
it("opens by keyboard, rejects repeat activation, and cleans up on cancellation", async () => {
  let dismiss!: () => void;
  host.popup.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        dismiss = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<Example />);
  await user.tab();
  await user.keyboard("{ArrowDown}{ArrowDown}");
  await waitFor(() => expect(host.create).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  dismiss();
  await waitFor(() => expect(host.close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
it.each(["create", "popup"] as const)(
  "falls back to the existing menu when native %s fails",
  async (failure) => {
    host[failure].mockRejectedValue(new Error("Unavailable"));
    const user = userEvent.setup();
    const action = vi.fn();
    render(<Example action={action} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(action).toHaveBeenCalledOnce();
    if (failure === "popup") expect(host.close).toHaveBeenCalledOnce();
  },
);
it.each(["browser", "windows"])(
  "keeps the web menu on %s",
  async (platform) => {
    if (platform === "browser") host.enabled = false;
    else vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeInTheDocument();
    expect(host.create).not.toHaveBeenCalled();
  },
);

it("falls back and releases earlier icons if a later icon cannot render", async () => {
  host.image
    .mockResolvedValueOnce({ rid: 9, close: host.imageClose })
    .mockRejectedValueOnce(new Error("Icon failed"));
  render(
    <Dropdown native>
      <Button>Actions</Button>
      <DropdownContent>
        <Dropdown.Item nativeIcon={<svg />}>Pin</Dropdown.Item>
        <Dropdown.Item nativeIcon={<svg />}>Edit</Dropdown.Item>
      </DropdownContent>
    </Dropdown>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Actions" }));
  expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeVisible();
  expect(host.imageClose).toHaveBeenCalledOnce();
  expect(host.create).not.toHaveBeenCalled();
});

it("passes shortcut accelerators alongside icons without adding key labels to native titles", async () => {
  render(
    <Dropdown native>
      <Button>New tab</Button>
      <DropdownContent>
        <Dropdown.Item
          textValue="Terminal"
          nativeIcon={<svg />}
          accelerator="CmdOrCtrl+J"
        >
          <Label>Terminal</Label>
          <kbd>⌘J</kbd>
        </Dropdown.Item>
      </DropdownContent>
    </Dropdown>,
  );
  await userEvent.click(screen.getByRole("button", { name: "New tab" }));
  await waitFor(() => expect(host.create).toHaveBeenCalledOnce());
  expect(host.create.mock.calls[0][0].items[0]).toMatchObject({
    text: "Terminal",
    accelerator: "CmdOrCtrl+J",
    icon: { rid: 9 },
  });
});

// The session Fork submenu must retain its own icon as well as each action's icon.
it("preserves submenu icons and accelerators in native options", async () => {
  render(
    <Dropdown native>
      <Button>Session actions</Button>
      <DropdownContent>
        <Dropdown.Item
          textValue="Rename"
          nativeIcon={<svg />}
          accelerator="CmdOrCtrl+Alt+R"
        >
          Rename
        </Dropdown.Item>
        <Dropdown.SubmenuTrigger>
          <Dropdown.Item textValue="Fork" nativeIcon={<svg />}>
            Fork
          </Dropdown.Item>
          <DropdownContent>
            <Dropdown.Item nativeIcon={<svg />}>Fork session</Dropdown.Item>
          </DropdownContent>
        </Dropdown.SubmenuTrigger>
      </DropdownContent>
    </Dropdown>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Session actions" }),
  );
  await waitFor(() => expect(host.close).toHaveBeenCalled());
  const items = host.create.mock.calls[0][0].items;
  expect(items[0]).toMatchObject({
    text: "Rename",
    accelerator: "CmdOrCtrl+Alt+R",
    icon: { rid: 9 },
  });
  expect(items[1]).toMatchObject({ rid: 11, kind: "Submenu" });
  expect(host.submenuClose).toHaveBeenCalledOnce();
  expect(host.submenu.mock.calls[0][0]).toMatchObject({
    text: "Fork",
    icon: { rid: 9 },
    items: [{ text: "Fork session", icon: { rid: 9 } }],
  });
});

/**
 * The bridge reads the declarative JSX children of `<Dropdown native>`, so it is broken by a
 * change in shape, not only by a change in props: a wrapper component around an item, a submenu
 * nested one level deeper, an item that carries `onClick` instead of `onAction`. These four cases
 * mirror the four production menus — `src/components/Sidebar.tsx` (~782),
 * `src/components/SessionMenu.tsx` (~129) and `src/components/TerminalDock.tsx` (~322, ~552) — so
 * that a shape regression fails here rather than in a hand test on macOS.
 *
 * The Sidebar case reproduces its trigger too. `SidebarMenuAction` is a plain (non-forwardRef)
 * component that spreads its props onto `controls/button`, and a `<Button>` stand-in would not
 * catch a bridge that starts requiring the trigger to be the button itself. It also carries the
 * two child shapes `Children.toArray` has to survive: an item behind a `&&` (`Sidebar.tsx:~841`)
 * and a `.map()` of items (`Sidebar.tsx:~858`).
 */
const projectTags = ["blue", "green"];
const canReveal = true;

const shapes = {
  "Sidebar project actions": (
    <Dropdown native>
      <SidebarMenuAction
        showOnHover
        className="right-7"
        aria-label="Project actions Example"
        title="Project actions"
      >
        <svg />
      </SidebarMenuAction>
      <DropdownContent className="w-[280px]" side="right" align="start">
        <Tooltip content="Pin project" className="w-full">
          <Dropdown.Item nativeIcon={<svg />} onAction={() => {}}>
            <svg />
            Pin
          </Dropdown.Item>
        </Tooltip>
        <Dropdown.Item nativeIcon={<svg />} onAction={() => {}}>
          <svg />
          Edit
        </Dropdown.Item>
        {canReveal && (
          <Dropdown.Item onAction={() => {}}>
            <svg />
            Reveal in Finder
          </Dropdown.Item>
        )}
        <Separator />
        <Dropdown.SubmenuTrigger>
          <Dropdown.Item>
            <svg />
            Project tag
          </Dropdown.Item>
          <DropdownContent className="w-48">
            {projectTags.map((name) => (
              <Dropdown.Item
                key={name}
                id={`color:${name}`}
                textValue={`${name} tag`}
                checked={name === "blue"}
                onAction={() => {}}
              >
                <span className="flex size-4 items-center" />
                {name}
              </Dropdown.Item>
            ))}
            <Separator />
            <Dropdown.Item onAction={() => {}}>No color</Dropdown.Item>
          </DropdownContent>
        </Dropdown.SubmenuTrigger>
        <Separator />
        <Dropdown.Item nativeIcon={<svg />} onAction={() => {}}>
          Remove project
        </Dropdown.Item>
      </DropdownContent>
    </Dropdown>
  ),
  "SessionMenu session actions": (
    <Dropdown native>
      <Button aria-label="Session actions">•••</Button>
      <DropdownContent className="w-56">
        <Dropdown.Item
          aria-label="Rename"
          textValue="Rename"
          nativeIcon={<svg />}
          accelerator="CmdOrCtrl+Alt+R"
          onAction={() => {}}
        >
          Rename<kbd className="ml-auto">⌥⌘R</kbd>
        </Dropdown.Item>
        <Separator />
        <Dropdown.SubmenuTrigger>
          <Dropdown.Item textValue="Fork" nativeIcon={<svg />} disabled>
            Fork
          </Dropdown.Item>
          <DropdownContent side="right">
            <Dropdown.Item nativeIcon={<svg />} onAction={() => {}}>
              Fork session
            </Dropdown.Item>
          </DropdownContent>
        </Dropdown.SubmenuTrigger>
      </DropdownContent>
    </Dropdown>
  ),
  "TerminalDock profiles": (
    <Dropdown native>
      <Button aria-label="Terminal profiles">▾</Button>
      <DropdownContent align="end">
        {[
          { path: "/bin/zsh", name: "zsh", default: true },
          { path: "/bin/bash", name: "bash", default: false },
        ].map((profile) => (
          <Dropdown.Item key={profile.path} onAction={() => {}}>
            {profile.name}
            {profile.default ? " (default)" : ""}
          </Dropdown.Item>
        ))}
      </DropdownContent>
    </Dropdown>
  ),
  "TerminalDock tab actions": (
    <Dropdown native>
      <Button aria-label="Actions for /repo">▾</Button>
      <DropdownContent align="end">
        <Dropdown.Item onAction={() => {}}>Split</Dropdown.Item>
        <Dropdown.Item onAction={() => {}}>Move to new group</Dropdown.Item>
      </DropdownContent>
    </Dropdown>
  ),
} as const;

/** The two shapes that carry a `Dropdown.SubmenuTrigger`. */
const submenuShapes = new Set<keyof typeof shapes>([
  "Sidebar project actions",
  "SessionMenu session actions",
]);

type NativeItem = { text?: string; items?: unknown[] };

it.each(Object.keys(shapes) as (keyof typeof shapes)[])(
  "describes %s to the native menu rather than falling back",
  async (shape) => {
    render(shapes[shape]);
    await userEvent.click(screen.getAllByRole("button")[0]);
    await waitFor(() => expect(host.create).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const items: NativeItem[] = host.create.mock.calls[0][0].items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item: unknown) => item != null)).toBe(true);
    if (!submenuShapes.has(shape)) {
      expect(host.submenu).not.toHaveBeenCalled();
      expect(items.some((item) => item.items)).toBe(false);
      return;
    }
    // A submenu reaches Tauri two ways, and `native-menu.ts` picks by icon: an icon-less one is a
    // nested `items` array on the parent entry, an icon-bearing one is built with
    // `Submenu.new({ …, items })` and the resolved handle takes the parent's slot. Either way an
    // empty child list is the regression `every(item != null)` cannot see, so check both sources.
    const nested: NativeItem[][] = [
      ...items.flatMap((item) => (item.items ? [item.items as NativeItem[]] : [])),
      ...host.submenu.mock.calls.map(
        (call) => (call[0] as { items: NativeItem[] }).items,
      ),
    ];
    expect(nested).toHaveLength(1);
    expect(nested[0].length).toBeGreaterThan(0);
    expect(nested[0].every((item: unknown) => item != null)).toBe(true);
    if (shape !== "Sidebar project actions") return;
    // The `&&` child and the `.map()` children survived `Children.toArray`.
    expect(items.map((item) => item.text)).toContain("Reveal in Finder");
    expect(nested[0].map((item) => item.text)).toEqual(
      expect.arrayContaining(["blue tag", "green tag"]),
    );
  },
);

it("bails to the web menu when an item uses onClick instead of onAction", async () => {
  render(
    <Dropdown native>
      <Button aria-label="Imperative">•••</Button>
      <DropdownContent>
        <Dropdown.Item onClick={() => {}}>Rename</Dropdown.Item>
      </DropdownContent>
    </Dropdown>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Imperative" }));
  expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeVisible();
  expect(host.create).not.toHaveBeenCalled();
});
