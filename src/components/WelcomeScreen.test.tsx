import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: {
    isMock: false,
    listProjects: vi.fn(),
    pickDirectory: vi.fn(),
    addProject: vi.fn(),
  },
}));
vi.mock("../bridge", () => ({ bridge: () => api }));

import { WelcomeScreen } from "./WelcomeScreen";

beforeEach(() => {
  api.isMock = false;
  api.listProjects.mockResolvedValue([]);
  api.pickDirectory.mockResolvedValue("/repos/example");
  api.addProject.mockResolvedValue({ id: "p1", name: "example" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

it("shows the brand mark and the three action rows with no project selected", async () => {
  render(<WelcomeScreen />);
  expect(screen.getByRole("img", { name: "Brigadier" })).toBeVisible();
  expect(row("New project")).toBeVisible();
  expect(screen.getByText("Create one from a local folder")).toBeVisible();
  expect(row("New chat")).toBeVisible();
  expect(row("Notepad")).toBeVisible();
  expect(screen.getByText("Keep notes alongside your work")).toBeVisible();
  // No card, no border: the row is the hit target and the fill is the whole affordance.
  expect(row("Notepad").className).toContain("rounded-[var(--radius-row)]");
});

it("takes the folder picker and add_project path for New project", async () => {
  render(<WelcomeScreen />);
  const changed = vi.fn();
  window.addEventListener("brigadier-navigation-changed", changed);
  try {
    await userEvent.click(row("New project"));
    expect(api.pickDirectory).toHaveBeenCalledTimes(1);
    expect(api.addProject).toHaveBeenCalledWith("/repos/example");
    // The event App and navigationApi both listen on; nothing else reloads the project list.
    expect(changed).toHaveBeenCalled();
  } finally {
    window.removeEventListener("brigadier-navigation-changed", changed);
  }
});

it("adds nothing when the picker is cancelled", async () => {
  api.pickDirectory.mockResolvedValue(null);
  render(<WelcomeScreen />);
  await userEvent.click(row("New project"));
  expect(api.addProject).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("says where to go instead of silently failing in a browser", async () => {
  api.isMock = true;
  render(<WelcomeScreen />);
  await userEvent.click(row("New project"));
  expect(api.pickDirectory).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent("Add project in the sidebar");
});

it("disables New chat until a project exists", async () => {
  render(<WelcomeScreen />);
  expect(await screen.findByText("Add a project first")).toBeVisible();
  expect(row("New chat")).toBeDisabled();
});

it("dispatches the sidebar's own new-chat event once a project exists", async () => {
  api.listProjects.mockResolvedValue([{ id: "p1", name: "example" }]);
  render(<WelcomeScreen />);
  expect(await screen.findByText("Start a conversation in a project")).toBeVisible();
  const started = vi.fn();
  window.addEventListener("brigadier-new-chat", started);
  try {
    await userEvent.click(row("New chat"));
    expect(started).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("brigadier-new-chat", started);
  }
});

it("opens the notepad through the event the sidebar listens for", async () => {
  render(<WelcomeScreen />);
  const opened = vi.fn();
  window.addEventListener("brigadier-open-notes", opened);
  try {
    await userEvent.click(row("Notepad"));
    expect(opened).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("brigadier-open-notes", opened);
  }
});
