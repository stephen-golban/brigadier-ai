import { useEffect } from "react";
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
  reset: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("./launchApi", () => ({ launchApi: api }));
const workspace = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
vi.mock("./App", () => ({
  App: ({ onReady }: { onReady: () => void }) => {
    useEffect(onReady, [onReady]);
    if (workspace.pending) throw workspace.pending;
    return <div>Workspace ready</div>;
  },
}));
const initial = {
  name: "",
  completed: false,
  introSeen: false,
  music: false,
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
  api.reset.mockImplementation(async () => {
    api.preferences.mockResolvedValue({ ...initial });
    window.dispatchEvent(new Event("brigadier-reset-welcome"));
  });
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
  it("keeps the disc visible and Continue ready when motion is reduced", async () => {
    await mount();
    expect(document.querySelector(".launch")).toHaveClass("launch-reduced");
    expect(document.querySelector(".intro-disc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("does not unlock Continue when a logo fragment finishes animating", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    await mount();
    await animationEnd(document.querySelector(".intro-disc-stripe")!, "stripe-gather");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(document.querySelector(".intro-disc")).toBeInTheDocument();
  });

  it("lets the user reset from name entry back to a fresh introduction", async () => {
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Stephen" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset onboarding" })); });
    expect(api.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Your next idea starts here." })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue" })); });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("keeps name entry usable when resetting fails", async () => {
    api.reset.mockRejectedValueOnce(new Error("Cannot save preferences"));
    await enterName();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset onboarding" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot save preferences");
    expect(screen.getByRole("button", { name: "Reset onboarding" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
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
    expect(screen.getByText("Workspace ready").closest(".launch-app")).toHaveAttribute("inert");
    expect(
      screen.queryByRole("button", { name: /skip/i }),
    ).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(input).toBeInTheDocument();
    expect(api.complete).not.toHaveBeenCalled();
  });
  it("keeps the greeting and window in place while fading into the mounted workspace", async () => {
    await enterName();
    const app = screen.getByText("Workspace ready").closest(".launch-app");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Stephen" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(api.complete).toHaveBeenCalledWith("Stephen");
    const greeting = screen.getByText("Welcome, Stephen.");
    expect(app).not.toHaveStyle({ visibility: "hidden" });
    await act(async () => { vi.advanceTimersByTime(199); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "greeting");
    await act(async () => { vi.advanceTimersByTime(1); });
    // The minimum hold has elapsed, but the workspace still gets a paint opportunity.
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "greeting");
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "revealing");
    expect(screen.getByText("Welcome, Stephen.")).toBe(greeting);
    expect(app).toHaveAttribute("inert");
    await animationEnd(document.querySelector(".launch")!, "workspace-reveal");
    expect(screen.queryByRole("region", { name: "Welcome to Brigadier" })).not.toBeInTheDocument();
    expect(screen.getByText("Workspace ready").closest(".launch-app")).toBe(app);
    expect(app).not.toHaveAttribute("inert");
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
  it("replays without changing native geometry or asking for the name again", async () => {
    api.preferences.mockResolvedValue({ ...initial, name: "Stephen", completed: true, introSeen: true });
    await mount();
    await act(async () => { window.dispatchEvent(new Event("brigadier-replay-welcome")); });
    const headline = screen.getByRole("heading");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Return to workspace" })); });
    expect(api.complete).not.toHaveBeenCalled();
    expect(screen.getByRole("heading")).toBe(headline);
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "revealing");
    await animationEnd(document.querySelector(".launch")!, "workspace-reveal");
    expect(screen.queryByRole("region", { name: "Welcome to Brigadier" })).not.toBeInTheDocument();
  });
  it("keeps the welcome visible while saving progress and allows retry on failure", async () => {
    let rejectSeen!: (error: Error) => void;
    api.seen.mockImplementationOnce(() => new Promise((_, reject) => { rejectSeen = reject; }));
    await enterName();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Your next idea starts here." })).toBeInTheDocument();
    await act(async () => { rejectSeen(new Error("Cannot save progress")); });
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot save progress");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(api.seen).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Your name" })).toHaveFocus();
  });
  it("crossfades into name entry with the same background and defers workspace loading until it ends", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    await mount();
    await animationEnd(document.querySelector(".welcome-action")!, "welcome-button-reveal");
    const background = document.querySelector(".signal-field");
    const welcome = document.querySelector(".launch-welcome")!;
    const disc = document.querySelector(".intro-disc")!;
    expect(disc).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue" })); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "entering-name");
    expect(welcome).toBeInTheDocument();
    expect(document.querySelector(".intro-disc")).toBe(disc);
    expect(document.querySelector(".signal-field")).toBe(background);
    expect(document.querySelector(".welcome-name")).toHaveAttribute("inert");
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
    await animationEnd(document.querySelector(".welcome-name h1")!, "name-enter");
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "entering-name");
    await animationEnd(document.querySelector(".welcome-name")!, "name-enter");
    expect(screen.getByRole("textbox", { name: "Your name" })).toHaveFocus();
    expect(document.querySelector(".signal-field")).toBe(background);
    expect(welcome).not.toBeInTheDocument();
    expect(screen.getByText("Workspace ready")).toBeInTheDocument();
  });
  it("holds the greeting until the lazy workspace is ready without restarting its minimum hold", async () => {
    let resolveWorkspace!: () => void;
    workspace.pending = new Promise<void>((resolve) => { resolveWorkspace = resolve; });
    await enterName();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Stephen" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue" })); });
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "greeting");
    await act(async () => { workspace.pending = null; resolveWorkspace(); });
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "revealing");
  });
  it("holds the normal-motion greeting for 1.4 seconds and ignores nested animation completion", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    api.preferences.mockResolvedValue({ ...initial, introSeen: true });
    await mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Stephen" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue" })); });
    await act(async () => { vi.advanceTimersByTime(1399); });
    expect(document.querySelector(".launch")).toHaveAttribute("data-stage", "greeting");
    await act(async () => { vi.advanceTimersByTime(1); });
    await act(async () => { vi.advanceTimersByTime(50); });
    const launch = document.querySelector(".launch")!;
    expect(launch).toHaveAttribute("data-stage", "revealing");
    await animationEnd(document.querySelector(".welcome-greeting")!, "workspace-reveal");
    expect(launch).toBeInTheDocument();
    await animationEnd(launch, "workspace-reveal");
    expect(launch).not.toBeInTheDocument();
  });
});
