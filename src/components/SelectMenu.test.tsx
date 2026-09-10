/**
 * What this file pins is the ARIA shape `SelectMenu` gained when it moved onto Base UI's
 * `Combobox` (2026-09-11). Every role below was **measured** by rendering, not read off a doc
 * page — `docs/research/assistant-ui-composer.md` recorded Base UI's combobox roles as *asserted*
 * and left the measurement to this port. What came back:
 *
 *  - trigger: `role="combobox"`, `aria-haspopup="dialog"` — no longer a `button`;
 *  - filter field: `role="combobox"` too, `aria-haspopup="listbox"` — **not** the `searchbox` the
 *    hand-rolled version rendered, because `Combobox.Input` sets no `type="search"`. Two
 *    comboboxes are therefore in the tree while the popup is open, told apart by their names;
 *  - list: `role="listbox"`; options: `role="option"`; group: `role="group"`; empty state:
 *    `role="status"`.
 *
 * One timing rule the port paid for three times: **wait for focus to reach the filter before
 * typing.** Base UI moves focus into it a tick after the popup mounts, and only the first test in
 * a file is slow enough that the tick has already passed when `findByRole` resolves. A keystroke
 * that lands early goes to the trigger's typeahead, which sets the query without filtering the
 * list. `openFilter()` below is that wait; do not inline it away.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectMenu } from "./SelectMenu";

afterEach(cleanup);

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma", disabled: true },
];

/** The trigger. Named, because the filter field carries the same role. */
const trigger = () => screen.getByRole("combobox", { name: "Model" });
/** The filter field, once it actually holds focus. See the timing rule above. */
async function openFilter() {
  const field = await screen.findByRole("combobox", { name: "Search model" });
  await waitFor(() => expect(field).toHaveFocus());
  return field;
}

describe("select menu", () => {
  it("names the trigger, the list and the options with the roles Base UI emits", async () => {
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={options}
        onChange={vi.fn()}
        searchable
      />,
    );
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
    await user.click(trigger());
    const field = await openFilter();
    expect(field).toHaveAttribute("aria-haspopup", "listbox");
    expect(screen.queryByRole("searchbox")).toBeNull();
    const list = screen.getByRole("listbox");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(list).toContainElement(
      screen.getByRole("option", { name: "Alpha" }),
    );
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: "Gamma" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("filters on label, value and description, and shows the empty state", async () => {
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={[
          { value: "a", label: "Alpha", description: "the first letter" },
          { value: "b", label: "Beta" },
        ]}
        onChange={vi.fn()}
        searchable
      />,
    );
    await user.click(trigger());
    const field = await openFilter();
    await user.keyboard("bet");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Beta",
      ]),
    );
    await user.clear(field);
    await user.keyboard("first letter");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Alphathe first letter",
      ]),
    );
    await user.clear(field);
    await user.keyboard("zzz");
    await waitFor(() =>
      expect(screen.queryAllByRole("option")).toHaveLength(0),
    );
    expect(screen.getByRole("status")).toHaveTextContent("No matching options");
  });

  it("moves the highlight with the arrows, selects with Enter and closes with Escape", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={options}
        onChange={onChange}
        searchable
      />,
    );
    await user.click(trigger());
    await openFilter();
    // The first ArrowDown lands on the first row rather than moving off the selected one.
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger()).toHaveFocus());

    await user.click(trigger());
    await openFilter();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
        "data-highlighted",
      ),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("keeps a filterless menu operable and never renders a filter field", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={options}
        onChange={onChange}
      />,
    );
    await user.click(trigger());
    await screen.findByRole("listbox");
    expect(screen.queryByRole("combobox", { name: "Search model" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("heads a grouped list and keeps each option under its own group", async () => {
    const user = userEvent.setup();
    render(
      <SelectMenu
        label="Model"
        value="a"
        options={[
          { value: "a", label: "Alpha", group: "Anthropic", badge: "default" },
          { value: "z", label: "Zeta", group: "OpenAI" },
        ]}
        onChange={vi.fn()}
        searchable
      />,
    );
    await user.click(trigger());
    await openFilter();
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.textContent)).toEqual([
      "AnthropicAlphadefault",
      "OpenAIZeta",
    ]);
    expect(groups[0]).toContainElement(
      screen.getByRole("option", { name: /Alpha/ }),
    );
  });
});
