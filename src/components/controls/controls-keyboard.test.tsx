import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Dropdown, Popover } from "./overlay";
import { Modal } from "./modal";
import { Tabs } from "./tabs";

afterEach(cleanup);

it("skips disabled menu actions with arrows and restores trigger focus on Escape", async () => {
  const user = userEvent.setup();
  render(
    <Dropdown>
      <Button>Actions</Button>
      <Dropdown.Popover>
        <Dropdown.Menu aria-label="Actions">
          <Dropdown.Item>Rename</Dropdown.Item>
          <Dropdown.Item isDisabled>Unavailable</Dropdown.Item>
          <Dropdown.Item>Reveal</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>,
  );
  const trigger = screen.getByRole("button", { name: "Actions" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Reveal" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("opens a submenu by keyboard, returns to its trigger, and closes the whole menu on an action", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <Dropdown>
      <Button>Repository</Button>
      <Dropdown.Popover>
        <Dropdown.Menu aria-label="Repository">
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item>Stashes</Dropdown.Item>
            <Dropdown.Popover>
              <Dropdown.Menu aria-label="Stashes">
                <Dropdown.Item onAction={action}>Apply stash</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>,
  );
  await user.click(screen.getByRole("button", { name: "Repository" }));
  // Base UI opens on the animation frame after the press, and — unlike the hand-rolled menu it
  // replaced — a pointer-opened menu highlights nothing, so the first item is reached with a key.
  await screen.findByRole("menu", { name: "Repository" });
  await user.keyboard("{ArrowDown}{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "Apply stash" })).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("menuitem", { name: "Stashes" })).toHaveFocus();
  expect(
    screen.queryByRole("menu", { name: "Stashes" }),
  ).not.toBeInTheDocument();
  // Base UI settles a dismissed submenu over the next few frames; reopening inside that window
  // reopens the popup but leaves focus on the trigger (docs/STATUS.md §7).
  await new Promise((resolve) => setTimeout(resolve, 60));
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "Apply stash" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Repository" })).toHaveFocus();
});

it("keeps a pending confirmation open on Escape and restores focus when dismissed", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open confirmation</Button>
        <Modal.Backdrop
          isOpen={open}
          isKeyboardDismissDisabled={busy}
          onOpenChange={setOpen}
        >
          <Modal.Dialog>
            <Modal.Heading>Confirmation</Modal.Heading>
            <Button onClick={() => setBusy(false)}>Finish work</Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </Modal.Dialog>
        </Modal.Backdrop>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(screen.getByRole("button", { name: "Finish work" })).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Confirmation" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Finish work" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open confirmation" }),
  ).toHaveFocus();
});

it("moves between tabs with arrow keys without selecting a tab when its close button is clicked", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  function Example() {
    const [selected, select] = useState("files");
    return (
      <Tabs selectedKey={selected} onSelectionChange={select}>
        <Tabs.List aria-label="Workspace">
          <Tabs.Tab id="files">Files</Tabs.Tab>
          <Tabs.Tab id="note">
            Note
            <Button
              aria-label="Close note"
              onClick={(event) => {
                event.stopPropagation();
                close();
              }}
            >
              ×
            </Button>
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel id={selected}>{selected}</Tabs.Panel>
      </Tabs>
    );
  }
  render(<Example />);
  screen.getByRole("tab", { name: "Files" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("note");
  await user.keyboard("{ArrowLeft}");
  await user.click(screen.getByRole("button", { name: "Close note" }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole("tabpanel")).toHaveTextContent("files");
});

it("honors a field's autofocus ahead of an earlier close button", () => {
  render(
    <Modal.Backdrop isOpen>
      <Modal.Dialog aria-label="Rename">
        <Modal.CloseTrigger />
        <Input autoFocus aria-label="New name" />
      </Modal.Dialog>
    </Modal.Backdrop>,
  );
  expect(screen.getByRole("textbox", { name: "New name" })).toHaveFocus();
});

/**
 * The composer's popovers are styled entirely by `src/components/composer/composer.css`
 * (`.composer-popover`, `.permission-popover`, `.execution-popover`). Those rules are unlayered
 * author CSS, so they beat any Tailwind utility — but only on the element they land on. Before the
 * port the consumer's `className` went on a hand-positioned wrapper and `role="dialog"` sat on an
 * inner panel; now `PopoverContent` puts both on Base UI's `Popover.Popup`. This pins that: the
 * painted, positioned popup is the element carrying the composer classes, and none of the kit's
 * own geometry utilities survive `cn`'s tailwind-merge anywhere between the popup and the content.
 *
 * It lives in this file rather than its own so the suite keeps its file count. `Sidebar.test.tsx`'s
 * "opens project actions only on activation" is load-sensitive (Base UI hands a pointer-opened
 * menu its focus a frame late), and a 16th file in the `src/components/controls …` batch made it
 * fail 3/3 — at HEAD, with no source change at all.
 */
const KIT_GEOMETRY = ["w-72", "p-3", "p-4"];

it("puts the composer popover classes on the role=dialog popup, with no kit geometry left on it", async () => {
  const user = userEvent.setup();
  render(
    <div className="composer-surface">
      <Popover>
        <Button className="composer-permission composer-control">
          Full access
        </Button>
        <Popover.Content
          placement="top start"
          className="composer-popover permission-popover"
        >
          <Popover.Dialog aria-label="Permissions">
            <p className="composer-popover-heading">
              How should actions be approved?
            </p>
            <div role="listbox" aria-label="Permission policy">
              <button type="button" role="option" aria-selected>
                Ask for approval
              </button>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>,
  );
  await user.click(screen.getByRole("button", { name: "Full access" }));

  const dialog = await screen.findByRole("dialog", { name: "Permissions" });
  expect(dialog).toHaveClass("composer-popover", "permission-popover");
  // `place("top start")` -> Base UI's two props. jsdom cannot prove the resting coordinates
  // (floating-ui measures every rect as 0x0 here, so `shift`/`flip` never fire); this pins the
  // mapping only.
  expect(dialog).toHaveAttribute("data-side", "top");
  expect(dialog).toHaveAttribute("data-align", "start");
  // The two classes and the role are one element, not two.
  expect(document.querySelectorAll(".composer-popover")).toHaveLength(1);
  for (const utility of KIT_GEOMETRY) expect(dialog).not.toHaveClass(utility);

  // Nothing between the popup and the composer's own content re-imposes the kit's box either —
  // not the portal/positioner chain above it, nor any wrapper below it.
  expect(dialog.querySelector(".composer-popover-heading")).not.toBeNull();
  for (
    let node: HTMLElement | null = dialog;
    node && node !== document.body;
    node = node.parentElement
  )
    for (const utility of KIT_GEOMETRY) expect(node).not.toHaveClass(utility);
  for (const node of dialog.querySelectorAll("*"))
    for (const utility of KIT_GEOMETRY) expect(node).not.toHaveClass(utility);
});
