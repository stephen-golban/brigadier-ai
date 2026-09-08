import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMusic } from "./useMusic";

let context: {
  state: string;
  currentTime: number;
  destination: object;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
};
let source: {
  buffer: unknown;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
let gain: {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
const flush = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  source = {
    buffer: null, onended: null,
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  };
  gain = {
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  };
  context = {
    state: "running", currentTime: 2, destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue({ duration: 10 }),
    createGain: vi.fn(() => gain), createBufferSource: vi.fn(() => source),
  };
  vi.stubGlobal("AudioContext", vi.fn(function () { return context; }));
  vi.stubGlobal("Audio", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, arrayBuffer: async () => new ArrayBuffer(1),
  }));
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("plays once without a media element and releases audio when the clip ends", async () => {
  renderHook(() => useMusic("/audio/welcome.m4a", true));
  await flush();
  expect(Audio).not.toHaveBeenCalled();
  expect(source.start).toHaveBeenCalledOnce();
  expect(gain.gain.value).toBe(0.6);
  act(() => source.onended?.());
  fireEvent.pointerDown(window);
  await flush();
  expect(source.start).toHaveBeenCalledOnce();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it("does not allocate or load audio when disabled or no track is active", () => {
  const { rerender } = renderHook(({ track, enabled }) => useMusic(track, enabled), {
    initialProps: { track: "/audio/welcome.m4a" as string | null, enabled: false },
  });
  rerender({ track: null, enabled: true });
  expect(AudioContext).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("fades out and closes when music is disabled", async () => {
  const { rerender } = renderHook(({ enabled }) => useMusic("/audio/welcome.m4a", enabled), {
    initialProps: { enabled: true },
  });
  await flush();
  rerender({ enabled: false });
  expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 2.6);
  act(() => vi.advanceTimersByTime(599));
  expect(context.close).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(source.stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalledOnce();
});

it("retries blocked autoplay on interaction without starting duplicate sounds", async () => {
  context.state = "suspended";
  context.resume.mockRejectedValue(new Error("Gesture required"));
  renderHook(() => useMusic("/audio/welcome.m4a", true));
  await flush();
  expect(source.start).not.toHaveBeenCalled();
  context.resume.mockImplementation(async () => { context.state = "running"; });
  fireEvent.keyDown(window, { key: "Enter" });
  fireEvent.pointerDown(window);
  await flush();
  expect(source.start).toHaveBeenCalledOnce();
});

it("closes and prevents delayed decoding from starting sound after unmount", async () => {
  let decode!: (buffer: object) => void;
  context.decodeAudioData.mockReturnValue(new Promise((resolve) => { decode = resolve; }));
  const { unmount } = renderHook(() => useMusic("/audio/welcome.m4a", true));
  await flush();
  unmount();
  decode({ duration: 10 });
  fireEvent.pointerDown(window);
  await flush();
  expect(source.start).not.toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it("releases the context if the sound cannot be loaded", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("Network error"));
  renderHook(() => useMusic("/audio/welcome.m4a", true));
  await flush();
  fireEvent.pointerDown(window);
  await flush();
  expect(source.start).not.toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledOnce();
});
