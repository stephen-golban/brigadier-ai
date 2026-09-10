import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LayoutResizer } from "./LayoutResizer";

afterEach(cleanup);

/** jsdom implements neither pointer capture method, so the component's guard needs both. */
function capturable(element: HTMLElement) {
  let held = false;
  Object.assign(element, {
    setPointerCapture: () => {
      held = true;
    },
    releasePointerCapture: () => {
      held = false;
    },
    hasPointerCapture: () => held,
  });
  return element;
}

function drag(
  element: HTMLElement,
  from: { clientX?: number; clientY?: number },
  to: { clientX?: number; clientY?: number },
) {
  capturable(element);
  fireEvent.pointerDown(element, { pointerId: 1, ...from });
  fireEvent.pointerMove(element, { pointerId: 1, ...to });
  fireEvent.pointerUp(element, { pointerId: 1, ...to });
  fireEvent.lostPointerCapture(element, { pointerId: 1 });
}

it("publishes the separator contract a screen reader reads", () => {
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={275}
      min={240}
      max={520}
      onChange={vi.fn()}
    />,
  );
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle).toHaveAttribute("aria-valuemin", "240");
  expect(handle).toHaveAttribute("aria-valuemax", "520");
  expect(handle).toHaveAttribute("aria-valuenow", "275");
  expect(handle).toHaveStyle({ width: "16px" });
});

it("tracks the pointer along its own axis", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={275}
      min={240}
      max={520}
      onChange={onChange}
    />,
  );
  drag(
    screen.getByRole("separator"),
    { clientX: 275, clientY: 400 },
    { clientX: 335, clientY: 900 },
  );
  expect(onChange).toHaveBeenCalledWith(335);
});

it("reverses the drag for a panel that grows against it", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize workspace"
      value={280}
      min={240}
      max={900}
      invert
      onChange={onChange}
    />,
  );
  drag(screen.getByRole("separator"), { clientX: 700 }, { clientX: 640 });
  expect(onChange).toHaveBeenCalledWith(340);
});

it("drags along y when horizontal", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="horizontal"
      label="Resize terminal"
      value={260}
      min={120}
      max={600}
      invert
      onChange={onChange}
    />,
  );
  const handle = screen.getByRole("separator");
  expect(handle).toHaveStyle({ height: "16px" });
  drag(handle, { clientY: 500, clientX: 10 }, { clientY: 460, clientX: 800 });
  expect(onChange).toHaveBeenCalledWith(300);
});

it("scales pointer travel into the caller's units", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize terminal split"
      value={1}
      min={0.2}
      max={1.8}
      perPixel={() => 2 / 400}
      onChange={onChange}
    />,
  );
  drag(screen.getByRole("separator"), { clientX: 200 }, { clientX: 300 });
  expect(onChange).toHaveBeenCalledWith(1.5);
});

it("nudges by one step per arrow key, and ignores the other axis", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={275}
      min={240}
      max={520}
      onChange={onChange}
    />,
  );
  const handle = screen.getByRole("separator");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith(299);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(onChange).toHaveBeenLastCalledWith(251);
  fireEvent.keyDown(handle, { key: "ArrowUp" });
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(onChange).toHaveBeenCalledTimes(2);
});

it("reports a value under the minimum rather than clamping it", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={240}
      min={240}
      max={520}
      onChange={onChange}
    />,
  );
  drag(screen.getByRole("separator"), { clientX: 240 }, { clientX: 100 });
  expect(onChange).toHaveBeenCalledWith(100);
});

it("brackets a drag with the resize callbacks", () => {
  const onResizeStart = vi.fn();
  const onResizeEnd = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={275}
      min={240}
      max={520}
      onChange={vi.fn()}
      onResizeStart={onResizeStart}
      onResizeEnd={onResizeEnd}
    />,
  );
  drag(screen.getByRole("separator"), { clientX: 275 }, { clientX: 300 });
  expect(onResizeStart).toHaveBeenCalledTimes(1);
  expect(onResizeEnd).toHaveBeenCalledTimes(1);
});

it("ignores pointer movement it is not capturing", () => {
  const onChange = vi.fn();
  render(
    <LayoutResizer
      orientation="vertical"
      label="Resize sidebar"
      value={275}
      min={240}
      max={520}
      onChange={onChange}
    />,
  );
  const handle = capturable(screen.getByRole("separator"));
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
  expect(onChange).not.toHaveBeenCalled();
});
