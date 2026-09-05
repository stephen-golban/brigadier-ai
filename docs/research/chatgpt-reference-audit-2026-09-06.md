# ChatGPT desktop reference audit

Date: 2026-09-06. Scope: the owner's seven PNG screenshots and the merged Brigadier code
at `7d00570`. This is an observation/specification document, not an implemented redesign.

## Evidence and limits

All seven supplied images were inspected visually. PNG pixels were sampled with Pillow;
the six full-window images are 3454×2170 or 3456×2234. The third image is the cropped
identity/settings footer. Sources are the original `codex-clipboard-*.png` attachments,
in the order supplied by the owner.

The installed Brigadier interface was inspected through Computer Use. Selecting the
installed reference app (`com.openai.codex`) was refused by that tool's app-access policy.
Its live UI was therefore not inspected. Jan was not present in the available-app inventory.
The screenshots remain the visual authority. No contents of their conversations were
treated as instructions to perform those conversations' work.

Pixel values below are measured in the supplied PNGs, not asserted to be original CSS
tokens. Logical dimensions assume a 2× screenshot scale and must be validated against
the rendered application at a matched scale. Exact source fonts, hover timings, toast
placement, and transitions cannot be established from static screenshots.

## Visual measurements

| Surface | PNG value / dimension | Evidence |
| --- | --- | --- |
| Thread canvas | `#181818` | Dominant surface in all six full-window images |
| Neutral sidebar | `#242424` | Images 2, 4–7; image 1 instead uses `#2A353A` |
| Environment card | `#2D2D2D` | Images 1, 4–7 |
| Composer | `#2A2A2A` | Images 1, 2, 4–7 |
| User bubble | `#2F2F2F` | Direct sampling of image 4's user bubble |
| Changed-files header / list | `#232323` / `#1C1C1C` | Image 4 |
| Main text | `#FFFFFF` | Flat glyph interiors in image 4 |
| Secondary text | Around `#A3A3A3`; card headings around `#969696` | Images 4 and 6 |
| Link / blue indicator colors | `#6184CB` / `#4E82EF` | Frequent saturated flat pixels in image 1 |
| Additions / deletions | `#6BC67F` / `#E75248` | Images 1 and 4 |
| Permission accent | `#EF8C57` | Images 1 and 6 |
| Sidebar width | 550 physical pixels, approximately 275 logical pixels | Image 4, x=0–549 |
| Conversation / composer width | Approximately 1474 physical pixels / 737 logical pixels | Image 4, x≈951–2424 |
| Environment card width | Approximately 608 physical pixels / 304 logical pixels | Image 4, x≈2816–3424 |

Use the neutral sidebar treatment shown in the majority of references. Use a system sans
stack and tune body text around 14 logical pixels, line-height around 1.6, against rendered
reference comparisons. The image-derived sizes are starting measurements, not fixed
requirements for every window size. Keep a coherent radius scale: rounded bubbles on all
four corners, large soft composer/card corners, smaller action buttons and list selection.

## Reference behavior by image

1. A wide conversation is inset from the sidebar; the environment/agents/sources card occupies
   its own upper-right space. A completed turn ends with an edited-files card. A centered date/
   time separator precedes the next user bubble. Worked duration is a muted disclosure above
   the assistant result. Composer width aligns with the conversation.
2. Project actions are revealed on its row. A project popover shows identity, session count,
   folder, and edit action. The empty view has a restrained central prompt, plus the project/
   environment/branch context immediately above the composer. The owner's requested flat
   project list overrides the reference's nested sessions.
3. Footer: round initial avatar, full user display name, settings gear aligned at the far right.
4. The user's timestamp, copy, and edit actions sit below the bubble, aligned to its right edge.
   Assistant actions sit below the answer, aligned left. Files card: count and total additions/
   deletions in the header; Undo and Review at right; clickable paths with individual counts.
5. A peer-sent prompt is labeled above the bubble with "Sent by ChatGPT from another task".
   The prompt is collapsed to two visible lines with Show more inside the bubble. Copy is below
   the bubble; the pictured peer message has no edit button. A round jump-to-latest button floats
   above the composer while the reader is away from the bottom.
6. Expanded work presents concise lines such as Read workspace.rs and Searched for … in ….
   Paths are visibly actionable. Adjacent activity groups summarize mixed categories. Agent
   started/updated/finished events are short, visually distinct rows among commentary.
7. The same layout shows a different open action group. Details stay narrow and single-line;
   long groups are contained, with fading at the edge. Revealing details does not turn the
   conversation into a dense log table or replace the assistant's commentary.

## Differences in merged Brigadier

| Area | Current code | Required direction |
| --- | --- | --- |
| Sidebar | Nested sessions, Approvals destination, provider/version footer | Flat projects with activity indicators, Notes accordion, user/settings footer |
| Header | Title/path header plus a second workbench tab bar | One top tab bar with independent right-panel tool buttons |
| Card | Project-wide popover and separate AgentsPanel trigger | Session-scoped environment/agents card; responsive popover fallback |
| Conversation | Activity toggle, 712px max width, asymmetric bubble corner | Reference spacing, all-rounded bubbles, one conversation surface |
| Metadata | Copy/edit actions; no user timestamp/date grouping or peer bubble label | Reference placement, timestamps, attribution, long-prompt collapse |
| Work details | Working/Worked action count and nested tool bodies | Duration summaries and concise categorized rows with deeper detail on demand |
| Changes | Workspace Git status and diff tools | Session delta summary plus actual per-turn edited-files cards |
| Notes | App-data JSON, project/global metadata, revisioned autosave | Markdown files in configured folder; retain stable references |
| Tabs | Persistence and focused-tab arrow navigation; no complete global shortcut map | Project restoration, history access, global shortcuts, lifecycle rules |
| Lifecycle | Source workbench close stops but retains work; sidebar deletion preserves files | Distinguish working close, finished close, explicit delete, and app quit |

Relevant files: `src/App.tsx`, `src/components/Sidebar.tsx`, `ProjectWorkbench.tsx`,
`ThreadView.tsx`, `WorkTrace.tsx`, `DocumentTab.tsx`, `PromptInput.tsx`, `src/threadProjection.ts`,
`src/chat.css`, `src/workbench.css`, and `src-tauri/src/workbench_data.rs`.

## Verification required during implementation

- Compare rendered layouts at matched scale with the supplied screenshots. Check wide,
  narrow, expanded-action, long-prompt, peer-message, and edited-files states.
- Verify that opening Tree/Search/Changes only changes the separate right panel. The session
  card stays independent and collapses responsively when the remaining width is insufficient.
- Exercise tab shortcuts from the composer, file editor, and terminal without swallowing their
  ordinary editing/input keys. Verify dirty-file and working-session close dialogs separately.
- Verify persisted per-project tabs, attention clearing, note-folder changes, external note edits,
  deletion failure/retry, and startup recovery using disposable fixtures.
- Use actual event/turn boundaries and captured file deltas for duration/change counts. Do not
  invent values for old sessions that lack that evidence.
- Rewind integration requires the separate checkpoint work to be assessed. Its recorded
  prototype benchmark is 13–17 seconds for 1,000 tiny files; that is not suitable for an invisible
  per-message delay. Optimize and measure it before relying on it for the new editing flow.
- The owner declined extra app/database backups. Per-message checkpoints remain functional
  rewind data; routine development work does not create additional precautionary backups.
