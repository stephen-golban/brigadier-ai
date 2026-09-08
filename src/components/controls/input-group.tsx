import type { ComponentProps } from "react";
export { Button as InputGroupButton } from "./button";
export { Textarea as InputGroupTextarea } from "./textarea";
export function InputGroup(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="input-group"
      className={`input-group flex flex-col ${props.className ?? ""}`}
    />
  );
}
export function InputGroupAddon({
  align: _align,
  ...props
}: ComponentProps<"div"> & { align?: string }) {
  return (
    <div
      {...props}
      className={`flex items-center gap-2 p-2 ${props.className ?? ""}`}
    />
  );
}
