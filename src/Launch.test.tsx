import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Launch } from "./Launch";
const api = vi.hoisted(() => ({
  preferences: vi.fn(),
  status: vi.fn(),
  seen: vi.fn(),
  complete: vi.fn(),
  music: vi.fn(),
  finish: vi.fn(),
  reveal: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("./launchApi", () => ({ launchApi: api }));
const workspace = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./App", () => ({
  App: () => {
    if (workspace.pending) throw workspace.pending;
    return <div>Workspace ready</div>;
  },
}));
vi.mock("./components/CosmicField", () => ({ CosmicField: () => null }));
const initial = {
  name: "",
  completed: false,
  introSeen: false,
  music: false,
  desktopReveal: false,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  workspace.pending = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  api.preferences.mockResolvedValue({ ...initial });
  api.status.mockResolvedValue({ ready: true, error: null });
  api.seen.mockResolvedValue(undefined);
  api.finish.mockResolvedValue(undefined);
  api.reveal.mockResolvedValue(undefined);
  api.complete.mockImplementation(async (name: string) => ({
    ...initial,
    name: name.trim(),
    completed: true,
    introSeen: true,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function mount() {
  await act(async () => {
    render(<Launch />);
  });
}
async function enterName() {
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
}
async function animationEnd(element: Element, animationName: string) {
  const end = new Event("webkitAnimationEnd", { bubbles: true });
  Object.defineProperty(end, "animationName", { value: animationName });
  await act(async () => {
    element.dispatchEvent(end);
  });
}
describe("required first-use profile", () => {
  it("waits for the button's own animation completion instead of a wall-clock timeout", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    await mount();
    const button = screen.getByRole("button", { name: "Continue" });
    await act(async () => {
      vi.advanceTimersByTime(20000);
    });
    expect(button).toBeDisabled();
    // jsdom lacks AnimationEvent, so React selects its WebKit event alias here.
    const end = new Event("webkitAnimationEnd", { bubbles: true });
    Object.defineProperty(end, "animationName", {
      value: "welcome-button-reveal",
    });
    await act(async () => {
      button.parentElement!.dispatchEvent(end);
    });
    expect(button).toBeEnabled();
  });

  it("Enter advances only the ready welcome and never bypasses the name", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Enter",
    );
    for (const extra of [
      { repeat: true },
      { isComposing: true },
      { metaKey: true },
    ]) {
      fireEvent.keyDown(window, { key: "Enter", ...extra });
    }
    expect(api.seen).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
    });
    expect(api.seen).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Your name" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(api.complete).not.toHaveBeenCalled();
  });

  it("does not expose the workspace or a skip route before a name is saved", async () => {
    await enterName();
    const input = screen.getByRole("textbox", { name: "Your name" });
    expect(input).toHaveFocus();
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /skip/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(input).toBeInTheDocument();
    expect(api.complete).not.toHaveBeenCalled();
  });
  it("saves before greeting and only then hands off to the workspace", async () => {
    await enterName();
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(api.complete).toHaveBeenCalledWith("Stephen");
    expect(screen.getByText("Welcome, Stephen.")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(api.finish).not.toHaveBeenCalled();
    // Native geometry must stay put until the greeting has fully faded to its cover.
    expect(screen.getByText("Welcome, Stephen.")).toBeInTheDocument();
    expect(
      screen.getByText("Workspace ready").closest(".launch-app"),
    ).toHaveStyle({ visibility: "hidden" });
    await animationEnd(
      document.querySelector(".launch-window")!,
      "launch-depart",
    );
    expect(api.finish).toHaveBeenCalledOnce();
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "settling",
    );
    expect(api.reveal).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(api.reveal).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Workspace ready").closest(".launch-app"),
    ).not.toHaveStyle({ visibility: "hidden" });
    await animationEnd(document.querySelector(".launch")!, "workspace-reveal");
    expect(
      screen.queryByRole("region", { name: "Welcome to Brigadier" }),
    ).not.toBeInTheDocument();
  });
  it("resumes at required name entry after an interrupted introduction", async () => {
    api.preferences.mockResolvedValue({ ...initial, introSeen: true });
    await mount();
    expect(
      screen.getByRole("textbox", { name: "Your name" }),
    ).toBeInTheDocument();
    expect(api.seen).not.toHaveBeenCalled();
  });
  it("keeps the entered name and allows retry when saving fails", async () => {
    api.complete.mockRejectedValueOnce(new Error("Disk is read-only"));
    await enterName();
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Disk is read-only");
    expect(screen.getByRole("textbox")).toHaveValue("Stephen");
    expect(api.finish).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(screen.getByText("Welcome, Stephen.")).toBeInTheDocument();
  });
  it("does not treat animation time or a saved name as backend readiness", async () => {
    api.status.mockResolvedValue({ ready: false, error: null });
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      vi.advanceTimersByTime(2000);
    });
    expect(api.finish).not.toHaveBeenCalled();
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
  });
  it("shows startup failure instead of leaving an endless intro", async () => {
    api.status.mockResolvedValue({
      ready: false,
      error: "Data directory is locked",
    });
    await mount();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Data directory is locked",
    );
  });
  it("replays without erasing the profile or requiring name entry again", async () => {
    api.preferences.mockResolvedValue({
      ...initial,
      name: "Stephen",
      completed: true,
      introSeen: true,
    });
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("brigadier-replay-welcome"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Return to workspace" }),
      );
    });
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.finish).not.toHaveBeenCalled();
    await animationEnd(
      document.querySelector(".launch-window")!,
      "launch-depart",
    );
    expect(api.finish).toHaveBeenCalledOnce();
  });
  it("holds the opaque cover while native geometry is pending and allows retry on failure", async () => {
    let rejectFinish!: (error: Error) => void;
    api.finish.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFinish = reject;
        }),
    );
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await animationEnd(
      document.querySelector(".launch-window")!,
      "launch-depart",
    );
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "handoff",
    );
    expect(document.querySelector(".launch-surface")).toBeInTheDocument();
    expect(
      screen.getByText("Workspace ready").closest(".launch-app"),
    ).toHaveStyle({ visibility: "hidden" });
    await act(async () => {
      rejectFinish(new Error("Window restore failed"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Window restore failed",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await animationEnd(
      document.querySelector(".launch-window")!,
      "launch-depart",
    );
    expect(api.finish).toHaveBeenCalledTimes(2);
  });
  it("waits for the lazy workspace to commit before starting the handoff", async () => {
    let resolveWorkspace!: () => void;
    workspace.pending = new Promise<void>((resolve) => {
      resolveWorkspace = resolve;
    });
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "greeting",
    );
    expect(api.finish).not.toHaveBeenCalled();
    await act(async () => {
      workspace.pending = null;
      resolveWorkspace();
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "leaving",
    );
  });
  it("paints the app before releasing the native cover and waits for its removal before fading", async () => {
    let releaseCover!: () => void;
    api.reveal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCover = resolve;
        }),
    );
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Stephen" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await animationEnd(
      document.querySelector(".launch-window")!,
      "launch-depart",
    );
    expect(api.reveal).not.toHaveBeenCalled();
    expect(
      screen.getByText("Workspace ready").closest(".launch-app"),
    ).not.toHaveStyle({ visibility: "hidden" });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.reveal).toHaveBeenCalledOnce();
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "settling",
    );
    expect(document.querySelector(".launch-surface")).toBeInTheDocument();
    await act(async () => {
      releaseCover();
    });
    expect(document.querySelector(".launch")).toHaveAttribute(
      "data-stage",
      "revealing",
    );
  });
});
