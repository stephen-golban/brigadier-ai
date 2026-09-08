import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({
  enabled: true,
  create: vi.fn(),
  popup: vi.fn(),
  close: vi.fn(),
  image: vi.fn(),
  imageClose: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => host.enabled }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: host.create } }));
vi.mock("./native-menu-image", () => ({ nativeMenuImage: host.image }));
import { Dropdown, Label, Separator } from "./overlay";
import { DropdownContent } from "./menu";
import { Button } from "./button";

beforeEach(() => {
  host.enabled = true;
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
