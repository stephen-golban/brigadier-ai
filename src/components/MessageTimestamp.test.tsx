import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageTimestamp, MessageTime } from "./MessageTimestamp";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("preserves locale text, reuses it during streaming, and updates Today after midnight", () => {
  vi.useFakeTimers();
  const at = new Date(2026, 8, 11, 12, 30).getTime();
  vi.setSystemTime(at);
  const expected = new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
  const format = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const {container, rerender} = render(<MessageTimestamp at={at}/>);
  expect(container).toHaveTextContent(`Today ${expected}`);
  rerender(<MessageTimestamp at={at}/>);
  expect(format).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date(2026, 8, 12, 12, 30));
  rerender(<MessageTimestamp at={at}/>);
  expect(container).not.toHaveTextContent("Today");
  expect(container).toHaveTextContent(new Date(at).toLocaleDateString(undefined, {month: "short", day: "numeric"}));
  expect(format).toHaveBeenCalledTimes(1);
});

it("keeps the action clock stable across status updates and follows changed timestamps", () => {
  const at = new Date(2026, 8, 11, 12, 31).getTime();
  const expected = new Date(at).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});
  const format = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const {container, rerender} = render(<MessageTime at={at}/>);
  rerender(<MessageTime at={at}/>);
  expect(container).toHaveTextContent(expected);
  expect(format).toHaveBeenCalledTimes(1);
  const next = at + 60000;
  rerender(<MessageTime at={next}/>);
  expect(format).toHaveBeenCalledTimes(2);
  expect(container.querySelector("time")).toHaveAttribute("datetime", new Date(next).toISOString());
});

it("shares visible minute labels across clocks and invalidates locale and timezone changes", () => {
  const at = new Date(2026, 8, 11, 12, 35).getTime();
  const format = vi.spyOn(Date.prototype, "toLocaleTimeString");
  const view = (time: number) => <><MessageTimestamp at={time}/><MessageTime at={time + 1000}/></>;
  const {rerender} = render(view(at));
  expect(format).toHaveBeenCalledTimes(1);
  const otherLanguage = navigator.language === "en-GB" ? "en-US" : "en-GB";
  vi.spyOn(navigator, "language", "get").mockReturnValue(otherLanguage);
  rerender(view(at));
  expect(format).toHaveBeenCalledTimes(2);
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(new Date(at).getTimezoneOffset() + 15);
  rerender(view(at));
  expect(format).toHaveBeenCalledTimes(3);
});
