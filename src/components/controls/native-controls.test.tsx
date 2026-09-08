import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Dropdown } from "./overlay";
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
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("menuitem", { name: "Apply stash" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("menuitem", { name: "Stashes" })).toHaveFocus();
  expect(
    screen.queryByRole("menu", { name: "Stashes" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{ArrowRight}{Enter}");
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
