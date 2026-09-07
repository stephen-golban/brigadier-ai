# Jan UI reference

Verified 2026-09-06 against fresh `janhq/jan` main checkout at `e2185dbc7db3a002da35b3688b57910ec6fd87b2`. Research only; Jan was not built or run and no Brigadier product code changed. This supplements `jan.md` and the earlier chat-source audits; their Brigadier dependency comparisons are historical.

## What library supplies the appearance?

Jan explicitly configures **shadcn/ui, New York style, neutral base, CSS variables, Lucide icons**. This is checked-in component source with project styling, not a Jan UI package that Brigadier can install. Its frontend package is private. [Configuration](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/components.json#L1), [package](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/package.json#L1).

The supporting stack is React 19, Tailwind CSS 4, Tauri 2, Radix UI primitives, Lucide and Tabler icons. Motion/Framer Motion, `tw-animate-css`, and dnd-kit are dependencies. Package versions in the manifest include React 19.0.0, Tailwind 4.1.17, Radix dropdown-menu ^2.1.16, dnd-kit core 6.3.1 and sortable 10.0.0. [Dependencies](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/package.json#L22).

Brigadier already has React 19, Tauri 2, Tailwind 4, and Phosphor icons (`package.json`, inspected locally). Adopting Jan's component foundation does not require replacing the existing app architecture. Matching its appearance also requires deliberate tokens, spacing, typography, radii and surface styling; installing the dependencies alone will not reproduce it.

## Project menus and requested behavior

Jan's dropdown wrapper uses **Radix Dropdown Menu** and renders content through a **Portal**, with viewport-available height, scrolling, a border, shadow, rounded corners, and entry/exit animation. Portaling is directly relevant to Brigadier's clipped menu. [Dropdown source](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/components/ui/dropdown-menu.tsx#L32).

The sidebar action stays visible when `data-state=open`, on row hover, or while focus remains in the row. Its existing open-state rule maintains opacity; it does not itself add a persistent background highlight. Brigadier's requested active icon should explicitly style the shared menu's open state. [Sidebar action](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/components/ui/sidebar.tsx#L692).

Jan's project menu currently offers **View Project, Edit Project, Delete Project**, positioned right/start on desktop. Its project list maps folders directly. The inspected sidebar code contains no right-click handler or dnd-kit sortable wiring; Jan's dnd-kit usage found in the frontend is in the MCP server editor. Therefore copying this menu does not supply the requested Codex-like project actions, project reordering, or right-click parity. [Project menu/list](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/components/left-sidebar/NavProjects.tsx#L35), [MCP drag-and-drop imports](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/containers/dialogs/AddEditMCPServer.tsx#L20).

## Glass and visual tokens

Jan's standard project menu is **opaque** in the inspected CSS: its background is `--popover`, dark value `oklch(0.205 0 0)`, and the dropdown component has no backdrop-blur class. The dark base background is `oklch(0.18 0 0)`. The radius base is `0.625rem`, with smaller/larger radius aliases. The font defaults to Inter. The stylesheet has a green sidebar default, so these raw defaults are not the same palette as the user's neutral/blue-gray screenshot. [Theme aliases/fonts](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/index.css#L22), [light/dark defaults](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/index.css#L98).

Jan does use CSS backdrop blur in particular places: dialog/sheet overlays and the model-provider chooser (95%-opaque background plus strong backdrop blur). That is ordinary CSS glass styling, not evidence of a dedicated Liquid Glass library. No native vibrancy/window-effects wiring was found in the searched `src-tauri/src` and Tauri config; this is a bounded source-search result, not proof about every platform or release. [Dialog overlay](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/components/ui/dialog.tsx#L30), [model chooser](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/web-app/src/containers/DropdownModelProvider.tsx#L515).

## Recommended reuse boundary

Adopt shadcn/Radix for shared menus, popovers and dialogs; use one Brigadier project-action definition for dots and context-menu entry points. Add persistent open styling, dismissal/focus behavior and viewport handling. Add sortable project state and persistence separately. Use the approved screenshot or selected Jan appearance as the visual authority, with explicit tokens and matched-scale visual checks. Preserve Brigadier's session execution, persistence, editor, terminal and virtualized feed rather than importing Jan's full frontend.

Jan's repository `LICENSE` identifies Apache License 2.0, credits Menlo Research, and requests attribution in user-facing documentation where appropriate. Any vendored source should retain its applicable notices; this note reports the repository text and does not resolve package-specific licensing. [License](https://github.com/janhq/jan/blob/e2185dbc7db3a002da35b3688b57910ec6fd87b2/LICENSE#L1).

## Supplement: shared shadcn foundation

Official documentation checked on 2026-09-06 confirms that shadcn distributes component source that the application owns and can edit. It recommends semantic CSS variables for colors, surfaces, focus states and corner radii, with dark-mode overrides. This supports a consistent Brigadier component layer instead of independently styling each control. [Ownership](https://ui.shadcn.com/docs), [theming](https://ui.shadcn.com/docs/theming).

The requested coverage exists: Accordion, Button (including icon sizes, ghost/outline variants and loading composition), Dropdown Menu, and right-click Context Menu. The current docs offer multiple primitive foundations; explicitly select the **Radix** versions to stay aligned with the inspected Jan source. New York remains documented in `components.json`; do not assume a fresh CLI default reproduces Jan's checked-in components. [Accordion](https://ui.shadcn.com/docs/components/radix/accordion), [Button](https://ui.shadcn.com/docs/components/radix/button), [Dropdown](https://ui.shadcn.com/docs/components/radix/dropdown-menu), [Context menu](https://ui.shadcn.com/docs/components/radix/context-menu), [configuration](https://ui.shadcn.com/docs/components-json).

Radix supplies menu open state, portals, collision handling, outside-interaction hooks, keyboard navigation, and Escape dismissal with focus return. Brigadier still needs its own shared action definitions, the requested visible/active dots treatment tied to menu-open state, and project drag ordering plus persistence. The cinematic startup, readiness coordination, soundtrack and Settings preferences are also application work rather than shadcn features. [Radix menu contract](https://www.radix-ui.com/primitives/docs/components/dropdown-menu).

Updated user direction: the intro and music should also play on repeat launches and be toggleable in Settings. Any earlier first-launch-only or silent-repeat recommendation is superseded; precise timing and toggle semantics remain interview decisions.
