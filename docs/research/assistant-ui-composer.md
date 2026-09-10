# assistant-ui Elements composer — should it replace brigadier's composer and its pickers?

Researched 2026-09-11. Primary sources only:

- `https://www.assistant-ui.com/elements/composer` and the five pages it links
  (`composer-attachments`, `composer-slash-commands`, `composer-mentions`, `composer-model-picker`,
  `composer-voice`), plus `/elements/model-selector` and `/elements/composer-trigger-popover`.
- The monorepo at `1a5da0f272668cf313e5213e49aa70e0f987de6d` — the same SHA
  `src/components/ui/UPSTREAM.md` pins for the vendored kit. Paths below are
  `packages/ui/src/components/react/assistant-ui/elements/<file>` and the docs' own MDX at
  `apps/docs/content/elements/<file>.mdx`.
- `https://r.assistant-ui.com/registry.json` (151 items) and the per-item JSON, fetched both from
  the default namespace and from the `styles/base-nova/` namespace that
  `components.json` pins (`"registries": { "@assistant-ui": ".../styles/{style}/{name}.json" }`).

Every claim below is **measured** (read in the fetched source, docs or registry JSON) unless it says
**asserted**. The not-checked list is at the end.

## Summary

1. The Elements composer is **not one component**. It is 18 presentational exports plus 3 helpers in
   a single file (`elements-composer`), and the things the owner called "its own pickers" are four
   separate registry items with three unrelated implementations. **Measured.**
2. The composer file's own model lane — `ComposerModelTrigger` + `ComposerMenu` + `ComposerModelItem`
   — is a plain `<button>` and a `<div>` of `<button>`s. **No listbox, no option, no popover
   primitive, no filtering, no keyboard model.** It is thinner than brigadier's `SelectMenu`.
   **Measured** (`composer.tsx:142-187, 430-477`).
3. The one genuinely richer picker, `ModelSelector` (`elements-model-selector`), is a Popover wrapping
   a **cmdk `Command`**, and it reaches into cmdk's internals by attribute selector
   (`[cmdk-root]`, `[cmdk-input]`) to make its effort radiogroup keyboard-correct. cmdk is banned by
   `src/dependency-hygiene.test.ts:23-38`. **Measured.**
4. **No runtime is required** for any of the pickers. The `@assistant-ui/react` imports live only in
   the `.aui.tsx` wrappers. **Measured.**
5. Nothing in Elements has an analogue for project, worktree, branch or permission mode — four of
   brigadier's seven pickers. **Measured** (searched all 100 `elements-*` registry names).

**Recommendation: C** — keep brigadier's composer, move `SelectMenu` onto the kit's Base UI
`Combobox` (which the kit ships at `ui/base/combobox.tsx` and brigadier has not yet vendored), and
borrow `ModelSelector`'s **data model** (`ModelOption`, `efforts`, `resolveModelEffort`) rather than
its code. Reasons and landmines below.

## Component table

Registry names are the item id; prefix `@assistant-ui/` for `npx shadcn add`. "base-nova deps" is
what the `styles/base-nova/` JSON declares, which is what brigadier's `components.json` would fetch.

| Registry item | Source path @ `1a5da0f` | Purpose | base-nova deps / registry deps |
| --- | --- | --- | --- |
| `elements-composer` | `elements/composer.tsx` | The whole bar as 18 presentational exports (see below) | `lucide-react`; `elements-surfaces`, `elements-range` |
| `elements-model-picker` | `elements/model-picker.tsx` | Full-page model list grouped by family, price + capability chips | `lucide-react`; `elements-surfaces` |
| `elements-model-selector` | `elements/model-selector.tsx` | The searchable model popover + reasoning-effort row | `lucide-react`, `class-variance-authority`, `@base-ui/react`; **`command`**, **`popover`** |
| `model-selector` | `elements/model-selector.aui.tsx` | Runtime wrapper: registers the choice into `aui.modelContext` | `@assistant-ui/react`; `elements-model-selector` |
| `composer-trigger-popover` | `elements/composer-trigger-popover.aui.tsx` | The `/` and `@` character-triggered popover | `@assistant-ui/react`, `lucide-react` |
| `elements-reasoning-effort` | `elements/reasoning-effort.tsx` | Standalone effort pills + a thinking-budget `progressbar` | none; `elements-surfaces`, `elements-range` |
| `elements-mobile-composer` | `elements/mobile-composer.tsx` | Bottom-sheet composer, one export `MobileComposer` | `lucide-react`; `elements-surfaces` |
| `attachment` | `elements/attachment.aui.tsx` | Runtime attachment chip/preview | `@assistant-ui/react`, `lucide-react`; `dialog`, `tooltip`, `avatar`, … |
| `elements-message-attachment` | `elements/message-attachment.tsx` | Attachments as *received*, not staged (message side) | `lucide-react`; `elements-surfaces` |
| `elements-voice` / `voice` | `elements/voice.tsx` / `voice.aui.tsx` | Dictation button + waveform | `elements-voice`, `button`, `tooltip-icon-button` |
| `elements-surfaces` | `elements/surfaces.tsx` | `paper` / `field` / `floating` / `ghostButton` / `inkButton` / `mono` tokens | `tw-shimmer` |
| `elements-range` | `utils/range.ts` | `clamp` / `pct` | none |

There is **no** tool toggle, mode toggle or slash/mention *registry item of its own*: slash commands
and mentions are documented pages that compose `elements-composer`'s `ComposerMenu` /
`ComposerCommandItem` / `ComposerPersonItem` (standalone lane) or `composer-trigger-popover`
(runtime lane). Searched all 100 `elements-*` names in `registry.json`; the only `tool`-named items
(`elements-tool-call`, `-tool-group`, `-tool-timeline`, `-tool-error`) are message-side, not composer
controls. **Measured.**

### What `elements-composer` actually exports

`Composer`, `ComposerBar`, `ComposerMenu`, `ComposerMenuItem`, `ComposerCommandItem`,
`ComposerPersonItem`, `ComposerAttachments`, `ComposerAttachmentChip`, `ComposerInput`,
`ComposerVoice`, `ComposerToolbar`, `ComposerActions`, `ComposerAttachButton`,
`ComposerModelTrigger`, `ComposerModelItem`, `ComposerContext`, `ComposerVoiceButton`,
`ComposerSend`; helpers `useSlashMatches`, `useMentionMatches`, `applyMention`. Types
`ComposerAttachment`, `ComposerCommand`, `ComposerPerson`, `ComposerModel`, `ComposerUsage`.
**Measured** (`composer.tsx`, 659 lines, all of it read).

Two things worth naming:

- `ComposerInput` is an `<input>`, not a textarea (`composer.tsx:311-333`). brigadier's composer is a
  Lexical contenteditable (`composer/RichPromptEditor.tsx`) and its tests query
  `getByRole("textbox")` with `contenteditable="true"`.
- `ComposerSend` is one button whose `aria-label` flips between `"Send message"` and
  `"Stop generating"` on a `streaming` prop (`composer.tsx:624-658`) — the same shape brigadier
  already has.

### Which of these are pickers, and on what primitive

| Picker | Primitive | Notes |
| --- | --- | --- |
| `ComposerModelTrigger` + `ComposerMenu` + `ComposerModelItem` | **none** — bare `<div>` / `<button>` | Open/close, filtering and keyboard are the caller's. `ComposerMenu` is a CSS-transitioned absolutely-positioned div; it is not a Popover and does not trap focus or handle collisions. |
| `ModelPicker` (`elements-model-picker`) | **none** — `<button aria-pressed>` rows | A static list, not a menu. No trigger, no search. |
| `ModelSelector` (`elements-model-selector`) | **shadcn `Popover` + cmdk `Command`** + Base UI `RadioGroup`/`Radio` for the effort row | The only one with search, groups, empty state and a real keyboard model. |
| `ComposerTriggerPopover` | `ComposerPrimitive` from `@assistant-ui/react` | `/` and `@`; runtime-only. |
| `ReasoningEffort` (`elements-reasoning-effort`) | **none** — `<button aria-pressed>` pills + a `role="progressbar"` budget bar | Separate from `ModelSelectorEffort`. |

Nothing in the composer umbrella uses the kit's `Select` or `DropdownMenu`. **Measured.**

**Dependency answers, directly:**

- **cmdk** — yes, for `elements-model-selector` only, and unavoidably. Its base-nova JSON's
  `registryDependencies` are the bare names `command` and `popover`, which resolve against shadcn's
  own registry; `https://ui.shadcn.com/r/styles/base-nova/command.json` declares
  `"dependencies": ["cn", "cmdk"]`. Beyond the install, the source **codes against cmdk**:
  `<Command shouldFilter={…} defaultValue={…}>`, `<CommandItem keywords={[…]}>`, and in
  `ModelSelectorEffort` a `closest("[cmdk-root]")?.querySelector("[cmdk-input]")` that re-dispatches
  arrow keys into cmdk's input (`model-selector.tsx:643-660`). **Measured.**
- **lucide-react** — every item above except `elements-reasoning-effort` and `elements-range`
  declares it. Same substitution brigadier already does for `src/components/ui/` (`UPSTREAM.md`):
  `CheckIcon`/`ChevronDownIcon` → `src/icons`. Cheap. **Measured.**
- **`@assistant-ui/react` runtime hooks** — only in `.aui.tsx` files. `model-selector.aui.tsx` uses
  `useAui()` + `api.modelContext.register`; `composer-trigger-popover.aui.tsx` uses
  `ComposerPrimitive`, `unstable_useTriggerPopoverScopeContext`,
  `unstable_defaultDirectiveFormatter`. `composer.tsx`, `model-picker.tsx`, `model-selector.tsx`,
  `reasoning-effort.tsx`, `mobile-composer.tsx` import **zero** assistant-ui packages. **Measured.**
- **A model-context contract** — only in the runtime lane, and it is thin: `register({
  getModelContext: () => ({ config: { modelName, reasoningEffort } }) })`, which
  `@assistant-ui/ai-sdk`'s `AssistantChatTransport` then puts in the request body
  (`model-selector.mdx:255-262`). brigadier does not use that transport; the register call would be
  dead weight. **Measured.**

## Model picker API

Two different things share the name. Both are props-driven and neither needs a runtime.

### `ModelPicker` — `elements-model-picker`

```ts
interface PickableModel {
  id: string; name: string; family: string;
  context: string; price: string;          // pre-formatted strings, not numbers
  capabilities: readonly string[];          // rendered as chips
}
ModelPicker(props: { models: readonly PickableModel[]; selectedId: string; onSelect?: (id: string) => void })
```

Groups by `family` in first-seen order (`[...new Set(models.map(m => m.family))]`,
`model-picker.tsx:31`). No search, no trigger, no popover. Rows are `<button type="button"
aria-pressed={selected}>` — **role `button`, not `option`**. `data-slot="model-picker"` is the only
styling hook besides the surface tokens. **Measured.**

### `ModelSelector` — `elements-model-selector` (+ `model-selector` for the runtime wrapper)

```ts
type ModelOption = {
  id: string; name: string;
  description?: string;                     // subtitle under the name
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: readonly string[];             // extra search terms beyond id and name
  efforts?: boolean | readonly { id: string; name: string }[];  // true ⇒ Low/Med/High
};
type ModelSelectorProps = {
  models; value?; defaultValue?; onValueChange?;
  effort?; defaultEffort?; onEffortChange?;
  open?; defaultOpen?; onOpenChange?;
  searchable?: boolean;                     // default false
  variant?: "outline" | "ghost" | "muted";  // default "outline"
  size?: "sm" | "default" | "lg";
  align?: "start" | "center" | "end";
  className?; contentClassName?;
};
```

- **Listing**: `models` is one flat array; the default `ModelSelectorList` renders them all in one
  `CommandGroup`. Provider grouping is opt-in — you pass your own `children` of
  `ModelSelector.Group` + `ModelSelector.Item`. **Measured** (`model-selector.tsx:487-516`).
- **Filtering**: cmdk's, not the component's. `Content` sets `shouldFilter={!unfiltered}` and each
  `Item` gets `value={model.id} keywords={[model.name, ...model.keywords]}`. **Measured.**
- **Description / badges**: `description` renders as a muted subtitle; `icon` before the name; a
  check mark on the selected row. **No price or capability chips** — those exist only on
  `ModelPicker`. **Measured.**
- **Effort**: `ModelSelectorEffort` renders `null` when the selected model has no `efforts`, and
  effort is *sticky* across model switches — `resolveModelEffort(models, modelId, effort)` returns
  `undefined` rather than clearing the stored choice. Exported as a standalone helper.
  **Measured** (`model-selector.tsx:74-89`).
- **Styling hooks**: `data-slot="model-selector-{trigger,value,content,search,list,empty,group,separator,item,effort}"`,
  plus `data-variant` / `data-size` on the trigger and the exported `modelSelectorTriggerVariants`
  cva. **Measured.**

**Accessibility roles.** From `model-selector.mdx:104-120` (anatomy) and `:273` (the table), both
confirmed against the source:

| Part | Role |
| --- | --- |
| Trigger | `role="combobox"` `aria-haspopup="listbox"`, explicitly set on a `<button>` (`model-selector.tsx:266-267`); ArrowUp/ArrowDown open it |
| Content | a cmdk `Command` inside `PopoverContent` |
| Search input | cmdk `CommandInput` — no role set by assistant-ui |
| List | cmdk `CommandList` |
| Item | cmdk `CommandItem` |
| Effort row | Base UI `RadioGroup` with `role="radio"` children (the source's own `querySelectorAll('[role="radio"]')` confirms) |

### Would `PromptInput.test.tsx` change? Yes — both queries, on every path but C.

Today (`src/components/PromptInput.test.tsx:44-51`, against `src/components/SelectMenu.tsx`):

```tsx
await user.click(screen.getByRole("button", { name: /Model$/ }));          // controls/button.tsx, aria-label="Model"
await user.type(screen.getByRole("searchbox", { name: "Search model" }),   // controls/input.tsx type="search"
                "bet{Enter}");
expect(screen.queryByRole("listbox")).not.toBeInTheDocument();             // controls/listbox.tsx
```

- **If the picker becomes `ModelSelector`**: query 1 → `getByRole("combobox", { name: /Model/ })`
  (the trigger's own role, set in source). Query 2 → **not `searchbox`**. `ModelSelectorSearch`
  forwards props to `CommandInput` and sets neither `role` nor `type="search"`; under brigadier's
  cmdk-free `src/components/ui/command.tsx:40-58` it is a bare `<input>` with no role and no type,
  which resolves to role **`textbox`**. Under real cmdk it is whatever cmdk sets — asserted to be
  `combobox`, **not verified** (see not-checked). Either way an explicit
  `aria-label="Search model"` must be passed through, because the component's default is only a
  `placeholder`. The `queryByRole("listbox")` assertion survives only if the `CommandList` in use
  carries `role="listbox"` — brigadier's port does (`ui/command.tsx:64`).
- **If the picker becomes Elements' own `ComposerModelTrigger` + `ComposerMenu`**: query 1 survives
  (still a `<button>`, though the accessible name would come from its text, not an `aria-label`),
  query 2 has **nothing to query** — there is no search input — and the `listbox` assertion at line
  51 fails permanently, because the menu is a `<div>` of `<button>`s with no ARIA at all.
- **Path C** (`SelectMenu` onto the kit's Base UI `Combobox`): query 1 becomes
  `getByRole("combobox")`, since Base UI's `Combobox.Input` is itself the combobox; query 2 collapses
  into query 1. This is a real test edit either way — the `searchbox` role only exists today because
  `SelectMenu.tsx:65` passes `type="search"` by hand.

## Runtime coupling

**Verdict: not coupled. The pickers are usable standalone with plain props, and brigadier's existing
`@assistant-ui/react` wiring is irrelevant to them.**

- `composer.tsx`, `model-picker.tsx`, `model-selector.tsx`, `reasoning-effort.tsx` and
  `mobile-composer.tsx` contain no import from any `@assistant-ui/*` package. **Measured** (read in
  full or grepped at the SHA).
- Every docs page carries a `<RuntimeMode>` / `<StandaloneMode>` split and says so outright:
  "Standalone, `Composer` and its children are presentational: they render the shape and animate the
  visible states, but hold no text, attachments, or run status of their own" (`composer.mdx:80`).
- Only `model-selector.aui.tsx`, `composer-trigger-popover.aui.tsx`, `attachment.aui.tsx`,
  `thread.aui.tsx` and `voice.aui.tsx` need `AssistantRuntimeProvider`. The registry keeps that split
  honest: `model-selector` declares `@assistant-ui/react`, `elements-model-selector` does not.
- What *is* runtime-coupled is the composer's **behaviour**: attachments (`CompositeAttachmentAdapter`),
  slash commands (`unstable_useSlashCommandAdapter`), mentions (`unstable_useMentionAdapter`), voice
  (`WebSpeechDictationAdapter`) and the send/cancel swap (`AuiIf` + `ComposerPrimitive.Send/Cancel`)
  all exist only in the runtime lane. Take the runtime lane and the composer's text and send become
  thread state.

How far brigadier is already wired, for the record (**measured**, worktree `ui-sidebar`):

- `src/components/TranscriptRuntime.tsx` mounts `AssistantRuntimeProvider` /
  `useExternalStoreRuntime` (writable) or `AuiProvider` + `ReadonlyThreadProvider` (read-only), with
  `onNew` → `bridge().sendTurn(sessionId, text)` and `onCancel` → `bridge().interrupt(sessionId)`.
- `src/components/ThreadView.tsx` renders `Thread` from
  `src/components/assistant-ui/elements/thread.tsx` (which imports `ThreadPrimitive`).
- `src/components/assistant-ui/elements/composer.tsx` is a **trimmed, runtime-free** copy of
  Elements' composer: `ComposerBar`, `ComposerInput` (retargeted onto `controls/textarea`) and
  `ComposerActions` — three of the eighteen. `chat-panel.tsx` is likewise pure presentation.
- So the runtime exists **for the transcript only**. `NewSession` starts a *task*; it does not send a
  turn into an existing thread, and `useExternalStoreRuntime`'s composer has no concept of a
  worktree, a branch or a permission mode. Adopting the runtime composer means routing task creation
  through `onNew`, which is a different feature, not a port.

## Fit table — brigadier's seven pickers

| brigadier picker (file) | Elements analogue | Verdict |
| --- | --- | --- |
| Provider (`composer/ExecutionControls.tsx`) | none — `ModelOption` has no provider field; grouping is caller-supplied `children` | No analogue; `ModelSelector.Group` could host it as a *group heading* rather than a second picker |
| Model (`SelectMenu.tsx` over `controls/overlay` + `controls/listbox`) | `ModelSelector` (search, groups, description, check) and `ModelPicker` (static grid) | Closest one-to-one, and the only Elements picker richer than what exists — but it is the cmdk one |
| Effort (`ExecutionControls.tsx`) | `ModelSelectorEffort` (radiogroup inside the model popover) and `elements-reasoning-effort` (standalone pills + budget bar) | One-to-one on *data* (`efforts`, `resolveModelEffort` sticky rule) but Elements folds it **into** the model popover; brigadier's is a sibling control |
| Permission mode (`ExecutionControls.tsx`) | none | No analogue. Elements has `elements-permission-grant`, which is an approval card, not a mode picker |
| Project (`composer/TaskSetupRail.tsx`) | none | No analogue anywhere in the 100 `elements-*` items |
| Worktree (`TaskSetupRail.tsx`) | none | No analogue |
| Branch (`TaskSetupRail.tsx`) | none | No analogue |

Two of seven have an Elements counterpart; one of those two (effort) has the wrong shape. **Measured.**

## Recommendation

**C — keep brigadier's composer; move `SelectMenu` onto the kit's Base UI primitive, and borrow
`ModelSelector`'s data model, not its code.** Concretely: vendor
`packages/ui/src/components/react/ui/base/combobox.tsx` at `1a5da0f` the way the other 27 kit files
were vendored (it is in the kit but **not** in the shadcn registry, so it is a manual copy and gets a
row in `UPSTREAM.md`), retarget `SelectMenu` at it, and adopt the `ModelOption` /
`efforts: boolean | {id,name}[]` / `resolveModelEffort` shape by hand — ~15 lines, MIT, no new
dependency.

**Reason 1 (fit).** Five of brigadier's seven pickers have no Elements analogue at all, and the two
that do are the two brigadier already handles. Adopting the Elements composer buys a bar shape
brigadier already has (`assistant-ui/elements/composer.tsx` is already a trimmed copy of it) and
costs a port of `TaskSetupRail`'s project/worktree/branch and `ExecutionControls`' permission mode
into a structure that has no place for them — plus an `<input>`-based `ComposerInput` that would
have to be thrown away for the Lexical editor regardless.

**Reason 2 (dependency wall).** The only Elements picker that is an upgrade is `ModelSelector`, and
it is cmdk-native, not cmdk-styled: `shouldFilter`, `CommandItem keywords`, `Command defaultValue`
and two `[cmdk-*]` attribute selectors. brigadier's cmdk-free `ui/command.tsx` implements none of
those four, so the file does not typecheck against it and its effort keyboard handling is dead on
arrival; installing real cmdk trips `src/dependency-hygiene.test.ts:23-38` and drags in four
individual `@radix-ui/react-*` packages that `CLAUDE.md` §5 forbids. C sidesteps the wall entirely,
because Base UI 1.8.0 — already a dependency — ships `Combobox` and `Autocomplete`
(`node_modules/@base-ui/react/combobox`, `/autocomplete`, version 1.8.0, **measured**), and the kit
already has a styled wrapper for it.

Path B (adopt only the model/effort pickers) is the honest runner-up and stays on the table for
`ModelPicker` alone — 109 lines, zero registry deps beyond `elements-surfaces`, no cmdk — if a
full-page model chooser is ever wanted. It is not a replacement for the composer's inline pill.

## Landmines

**Top landmine per path:**

- **A (adopt wholesale).** `ComposerMenu` — the substrate for the model list, slash commands and
  mentions in the standalone lane — has **no ARIA and no primitive**: an absolutely-positioned div of
  `<button>`s, positioned by `absolute bottom-full` with no collision handling
  (`composer.tsx:142-167`). brigadier's `controls/overlay.tsx` exists precisely because Base UI's
  collision defaults flipped a `side="top"` composer popover sideways across the text area
  (`ui/UPSTREAM.md`, `popover.tsx` row). Path A throws that fix away and regresses the composer to
  role-less menus, breaking `PromptInput.test.tsx:51`.
- **B (pickers only).** `ModelSelector` will *appear* to compile — brigadier's `ui/command.tsx`
  exports the same six names — and then silently not filter: `shouldFilter`, `keywords` and
  `defaultValue` are unknown props on plain `<div>`/`<input>`, and `closest("[cmdk-root]")` returns
  `null`, so the effort row's arrow keys go nowhere. A search box that renders and does nothing is
  worse than no search box.
- **C (kit Combobox).** The kit's `combobox.tsx` is **not in the shadcn registry** — `npx shadcn add`
  cannot fetch it; it is a raw-URL copy at a SHA with no changelog, exactly the situation
  `ui/UPSTREAM.md`'s header already warns about. And the test edit is unavoidable: the `searchbox`
  role at `PromptInput.test.tsx:45` exists only because `SelectMenu.tsx:65` hand-writes
  `type="search"`; Base UI's `Combobox.Input` sets `role="combobox"` on itself.

**Cross-cutting:**

- **Registry items carry no version.** Every item JSON has exactly
  `{name, type, title, description, dependencies, registryDependencies, files}` — no `version`, and
  `registry.json` has no version at the top level either. `r.assistant-ui.com` serves whatever is on
  `main`. There is no pinning and no changelog; the only durable pin is the raw-GitHub URL at a SHA,
  which is what `ui/UPSTREAM.md` already does. **Measured.**
- **Bare `registryDependencies` escape the pinned style.** `elements-model-selector` lists `command`
  and `popover` as bare names, which resolve against **shadcn's** registry, not
  `@assistant-ui`'s — and shadcn's base-nova `command` pulls cmdk. Installing an assistant-ui item
  can therefore install a forbidden package without cmdk appearing anywhere in an assistant-ui JSON.
  **Measured.**
- **The base/radix twin split reaches Elements too.** The monorepo has
  `model-selector.tsx` (Base UI `RadioGroup`/`Radio`) and `model-selector.radix.tsx` (monolithic
  `radix-ui`). The **default** `r.assistant-ui.com/elements-model-selector.json` serves the *radix*
  twin; only the `styles/base-nova/` (or `/base/`) namespace serves the Base UI one, byte-identical
  to the monorepo's `model-selector.tsx`. brigadier's `components.json` already points at
  `styles/{style}`, so this is handled — but a hand-typed `npx shadcn add
  "https://r.assistant-ui.com/elements-model-selector.json"` would import `radix-ui`. **Measured**
  (diffed both fetches).
- **`ComposerContext` shows a dollar figure by convention.** `ComposerModel.meta` is a free string and
  every doc example fills it with `"$3/M"`; `ModelPicker.price` likewise. `CLAUDE.md` §5: usage
  windows, never dollars. Any adoption has to repurpose those fields.
- **lucide-react** is declared by every composer item; `src/components/ui/` has zero lucide imports
  today and `src/icons` is the substitute. Elements uses `LucideIcon` as a **type** in
  `ComposerCommand.icon` and `ATTACHMENT_ICONS` (`composer.tsx:16,44,64-71`), so a port changes a
  public type, not just imports.

## Licence

MIT. `LICENSE` at `1a5da0f` reads "MIT License / Copyright (c) 2025 AgentbaseAI Inc." — the same
licence and holder already recorded for the vendored kit in `src/components/ui/UPSTREAM.md` and
`THIRD_PARTY_NOTICES.md`. Registry items carry no separate licence field; `packages/ui` is
`"private": true, "version": "0.0.0"` and unpublished, so there is no npm artefact and no semver —
copies are the only distribution channel. **Measured.**

## Update path

There is none automatic. Items are unversioned and served from `main`; a re-fetch is a diff against
whatever landed since. The existing discipline is right: pin the SHA, record the file and its
deviations in `src/components/ui/UPSTREAM.md`, and re-read the table before refreshing. For anything
taken from Elements rather than the kit, the same table needs an `assistant-ui/elements/` section —
`src/components/assistant-ui/elements/` currently has 21 files and **no** provenance table, only
per-file header comments ("Adapted from assistant-ui Elements (MIT)"). That gap is worth closing
whichever path is chosen. **Measured.**

## Not checked

- **cmdk's own ARIA roles.** I did not read cmdk's source, so "cmdk's `CommandInput` renders
  `role="combobox"`" is **asserted**, not measured. It matters only if brigadier ever installs real
  cmdk, which paths B and C both avoid. What *is* measured is brigadier's replacement:
  `ui/command.tsx:40-58` sets no `role` and no `type`, so its input is `textbox`.
- **Base UI `Combobox`'s roles.** I read the kit's `ui/base/combobox.tsx` (230 lines, 13 wrappers over
  `ComboboxPrimitive`) but not Base UI's internals. That `Combobox.Input` carries `role="combobox"`
  and `List`/`Item` carry `listbox`/`option` is **asserted** from Base UI's documented ARIA pattern,
  not read.
- **`elements-composer`'s rendered behaviour.** Nothing here was run. No component was mounted, no
  test was written, no screenshot taken. Every statement about roles in Elements' own files comes
  from reading the JSX.
- **`mobile-composer.tsx`** — I read only its export list (one export, `MobileComposer`), not its body.
- **`composer-attachments` / `composer-voice` / `composer-slash-commands` / `composer-mentions` MDX** —
  scanned for install commands, runtime imports and component names; not read end to end.
- **Whether `ModelSelector` would actually satisfy brigadier's model-picker UX** (provider grouping,
  the warning state `MenuOption.warning` drives, `disabled` reasons). `ModelOption` has `disabled`
  but no reason text and no warning state; `MenuOption.description` maps to `ModelOption.description`.
  Not prototyped.
- **The docs site's install commands.** `www.assistant-ui.com/elements/composer` renders them through
  a React component, and only one literal `npx shadcn@latest add` survives in the MDX
  (`model-selector.mdx:313`, for `@assistant-ui/elements-model-picker`). Item names above come from
  `registry.json`, which is the authoritative list; the exact CLI string per page is **not verified**.
- **Burn / paint impact.** Not measured. `elements-model-selector` adds a `MutationObserver` per open
  popover (`useLazyFlipSide`) and cmdk's filtering runs on every keystroke; neither was profiled
  against the 287–295 ms budget.
