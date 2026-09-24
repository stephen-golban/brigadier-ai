import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the named tokens from styles/tokens.css so that, for
// example, `h-control-sm` correctly overrides `h-control-md`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [
        "control-xs",
        "control-sm",
        "control-md",
        "control-lg",
        "button-xs",
        "button-sm",
        "button-md",
        "button-lg",
        "icon-button-xs",
        "icon-button-sm",
        "icon-button-md",
        "icon-button-lg",
        "icon-xs",
        "icon-sm",
        "icon-md",
        "icon-lg",
        "pill",
        "pill-x",
        "row",
        "row-sm",
        "kbd",
        "menu",
        "composer",
        "sidebar",
        "sidebar-icon",
        "titlebar",
        "traffic-lights",
        "inspector",
      ],
      container: ["thread"],
      radius: [
        "document",
        "control",
        "surface",
        "dialog",
        "thread",
        "capsule",
      ],
      text: ["code", "code-inline"],
      tracking: ["hero", "section"],
      font: ["display"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
