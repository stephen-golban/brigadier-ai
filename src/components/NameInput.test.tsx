import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NameInput } from "./NameInput";
import { validateDisplayName } from "../name";

afterEach(cleanup);
function Field() {
  const [name, setName] = useState("");
  return <NameInput aria-label="Name" value={name} onValueChange={setName} />;
}

describe("name input", () => {
  it("filters typing and pasted text while keeping Latin accents and spaces", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await user.type(input, "Ana12-Marie!");
    expect(input).toHaveValue("AnaMarie");
    await user.clear(input);
    await user.paste("Ștefan José 42🙂李И\u001c");
    expect(input).toHaveValue("Ștefan José ");
  });
  it("moves and selects with arrows without inserting control characters", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await user.type(input, "Stephen");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(input.selectionStart).toBe(5);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 5]);
    await user.keyboard("{ArrowRight}");
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
    await user.keyboard("{ArrowUp}{ArrowDown}");
    expect(input.selectionStart).toBe(7);
    expect(input).toHaveValue("Stephen");
  });
  it("handles macOS arrow control codes and preserves the caret when rejecting input", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await user.type(input, "Ana");
    fireEvent.keyDown(input, { key: "\u001c" });
    expect(input.selectionStart).toBe(2);
    fireEvent.input(input, { target: { value: "An\u001ca", selectionStart: 3, selectionEnd: 3 }, data: "\u001c", inputType: "insertText" });
    expect(input).toHaveValue("Ana");
    expect(input.selectionStart).toBe(1);
    await user.type(input, "7", { skipClick: true });
    expect(input).toHaveValue("Ana");
    expect(input.selectionStart).toBe(1);
    await user.type(input, "b", { skipClick: true });
    expect(input).toHaveValue("Abna");
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue("Ana");
  });
  it("rejects invalid saved values and normalizes Latin accents", () => {
    for (const name of ["A7", "A-B", "A\u001c", "A\n", "李", "Иван", "A🙂", "   "])
      expect(() => validateDisplayName(name)).toThrow();
    expect(validateDisplayName("  Jose\u0301  ")).toBe("José");
  });
});
