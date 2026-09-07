const latinLetter = /^\p{Script=Latin}$/u;
const letter = /^\p{Letter}$/u;

export function filterName(value: string): string {
  return [...value.normalize("NFC")]
    .filter((char) => char === " " || (latinLetter.test(char) && letter.test(char)))
    .join("");
}

export function validateDisplayName(value: string): string {
  const normalized = value.normalize("NFC");
  const name = normalized.trim();
  if (!name) throw new Error("Enter your name to continue");
  if (filterName(normalized) !== normalized)
    throw new Error("Use only Latin letters and spaces");
  if ([...name].length > 200)
    throw new Error("Use a name of up to 200 characters");
  return name;
}
