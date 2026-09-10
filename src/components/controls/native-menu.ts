import type { ReactElement } from "react";
import type { Image } from "@tauri-apps/api/image";
import { nativeMenuImage } from "./native-menu-image";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, Submenu, type MenuOptions } from "@tauri-apps/api/menu";

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

async function options(
  entries: NativeMenuEntry[],
  images: Map<ReactElement, Image>,
  submenus: Submenu[],
): Promise<NonNullable<MenuOptions["items"]>> {
  const result: NonNullable<MenuOptions["items"]> = [];
  for (const entry of entries) {
    if ("separator" in entry) {
      result.push({ item: "Separator" });
      continue;
    }
    if (entry.items) {
      const opts = {
        text: entry.text,
        enabled: entry.enabled,
        items: await options(entry.items, images, submenus),
      };
      if (!entry.icon) {
        result.push(opts);
        continue;
      }
      // Tauri's untagged item payload checks Icon before Submenu. Explicitly construct
      // icon-bearing submenus, otherwise the backend silently drops their children.
      const submenu = await Submenu.new({
        ...opts,
        icon: images.get(entry.icon),
      });
      submenus.push(submenu);
      result.push(submenu);
      continue;
    }
    result.push({
      text: entry.text,
      enabled: entry.enabled,
      ...(entry.checked === undefined ? {} : { checked: entry.checked }),
      ...(entry.icon ? { icon: images.get(entry.icon) } : {}),
      accelerator: entry.accelerator,
      action: entry.action,
    });
  }
  return result;
}

/**
 * Synchronous half of the check below. The caller needs it because taking the async path at all
 * defers the web menu's opening by a microtask, which is long enough for a pointer-opened menu to
 * miss the focus it is expected to have taken.
 */
export function nativeMenusAvailable() {
  return isTauri() && navigator.platform.startsWith("Mac");
}

/** Returns false when the caller should display its existing web menu. */
export async function showNativeMenu(
  entries: NativeMenuEntry[],
  anchor: HTMLElement,
): Promise<boolean> {
  if (!nativeMenusAvailable() || !entries.length) return false;
  let menu: Menu | undefined;
  const images = new Map<ReactElement, Image>();
  const submenus: Submenu[] = [];
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
    menu = await Menu.new({ items: await options(entries, images, submenus) });
    if (!anchor.isConnected) return true;
    const rect = anchor.getBoundingClientRect();
    await menu.popup(new LogicalPosition(rect.left, rect.bottom + 4));
    return true;
  } catch {
    return false;
  } finally {
    await menu?.close().catch(() => {});
    for (const submenu of submenus) await submenu.close().catch(() => {});
    await Promise.all(
      [...images.values()].map((image) => image.close().catch(() => {})),
    );
  }
}
