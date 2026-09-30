import { MagnifyingGlassSearch, XCircleFilled } from "@openai/apps-sdk-ui/components/Icon";
import { useState } from "react";

import {
  searchSettings,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  type SettingsSearchResult,
} from "@/app/settings/pages";
import { navRow, NavHeader, NavList, NavSection } from "@/app/sidebar/nav";
import { cn } from "@/lib/utils";
import { openSettings } from "@/state/actions";
import { useApp } from "@/state/store";

/** Opens a result's page, then brings the setting it found into view. */
function openResult({ page, row }: SettingsSearchResult) {
  openSettings(page.id);
  if (!row) return;
  requestAnimationFrame(() => {
    const target = [...document.querySelectorAll<HTMLElement>("[data-setting]")].find(
      (element) => element.dataset.setting === row.label,
    );
    target?.scrollIntoView({ block: "center" });
  });
}

/**
 * The sidebar panel while Settings is open: its title, a search field, then its pages in
 * their groups. Typing replaces the pages with the settings found, each with its page's name.
 */
export function SettingsNav() {
  const current = useApp((s) => (s.selection.type === "settings" ? s.selection.page : null));
  const [query, setQuery] = useState("");
  const results = query.trim() ? searchSettings(query) : null;

  return (
    <>
      <NavHeader title="Settings" />
      <div className="px-2 pb-2">
        <label className="h-nav-search rounded-capsule bg-foreground/8 focus-within:ring-ring/50 flex items-center gap-2 px-3 focus-within:ring-2">
          <MagnifyingGlassSearch aria-hidden className="text-muted-foreground size-icon-md shrink-0" />
          <input
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search settings"
            spellCheck={false}
            autoComplete="off"
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                // Esc clears the search first, before it leaves Settings.
                event.stopPropagation();
                setQuery("");
              }
              if (event.key === "Enter" && results?.[0]) openResult(results[0]);
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center"
              onClick={() => setQuery("")}
            >
              <XCircleFilled className="size-icon-md" />
            </button>
          )}
        </label>
      </div>

      <div className="scroll-edge-fade flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-2">
        {results ? (
          results.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1 text-sm">No settings match.</p>
          ) : (
            <NavList>
              {results.map((result) => {
                const Icon = result.page.icon;
                return (
                  <li key={`${result.page.id}:${result.row?.label ?? ""}`}>
                    <button
                      type="button"
                      className={cn(navRow, "h-auto items-start py-2.5")}
                      onClick={() => openResult(result)}
                    >
                      <Icon aria-hidden className="text-muted-foreground mt-0.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{result.row?.label ?? result.page.label}</span>
                        {result.row && (
                          <span className="text-muted-foreground truncate text-xs">
                            {result.page.label}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </NavList>
          )
        ) : (
          SETTINGS_GROUPS.map((group) => (
            <NavSection key={group} title={group}>
              <NavList>
                {SETTINGS_PAGES.filter((page) => page.group === group).map((page) => {
                  const Icon = page.icon;
                  return (
                    <li key={page.id}>
                      <button
                        type="button"
                        aria-current={page.id === current ? "page" : undefined}
                        className={navRow}
                        onClick={() => openSettings(page.id)}
                      >
                        <Icon aria-hidden className="text-muted-foreground" />
                        <span className="truncate">{page.label}</span>
                      </button>
                    </li>
                  );
                })}
              </NavList>
            </NavSection>
          ))
        )}
      </div>
    </>
  );
}
