import type { ReactElement } from "react";
import type { Image } from "@tauri-apps/api/image";
import { nativeMenuImage } from "./native-menu-image";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";

export type NativeMenuEntry =
  | { separator: true }
  | {
      text: string;
      enabled?: boolean;
      checked?: boolean;
      icon?: ReactElement;
      accelerator?: string;
      action?: () => void;
      items?: NativeMenuEntry[];
    };

function options(
  entries: NativeMenuEntry[],
  images: Map<ReactElement, Image>,
): NonNullable<MenuOptions["items"]> {
  return entries.map((entry) => {
    if ("separator" in entry) return { item: "Separator" };
    if (entry.items)
      return {
        text: entry.text,
        enabled: entry.enabled,
        items: options(entry.items, images),
      };
    return {
      text: entry.text,
      enabled: entry.enabled,
      ...(entry.checked === undefined ? {} : { checked: entry.checked }),
      ...(entry.icon ? { icon: images.get(entry.icon) } : {}),
      accelerator: entry.accelerator,
      action: entry.action,
    };
  });
}

/** Returns false when the caller should display its existing web menu. */
export async function showNativeMenu(
  entries: NativeMenuEntry[],
  anchor: HTMLElement,
): Promise<boolean> {
  if (!isTauri() || !navigator.platform.startsWith("Mac") || !entries.length)
    return false;
  let menu: Menu | undefined;
  const images = new Map<ReactElement, Image>();
  try {
    const prepare = async (items: NativeMenuEntry[]) => {
      for (const entry of items) {
        if ("separator" in entry) continue;
        if (entry.icon && !images.has(entry.icon))
          images.set(entry.icon, await nativeMenuImage(entry.icon));
        if (entry.items) await prepare(entry.items);
      }
    };
    if (
      entries.some(
        (entry) => !("separator" in entry) && (entry.icon || entry.items),
      )
    )
      await prepare(entries);
    menu = await Menu.new({ items: options(entries, images) });
    if (!anchor.isConnected) return true;
    const rect = anchor.getBoundingClientRect();
    await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
    return true;
  } catch {
    return false;
  } finally {
    await menu?.close().catch(() => {});
    await Promise.all(
      [...images.values()].map((image) => image.close().catch(() => {})),
    );
  }
}
