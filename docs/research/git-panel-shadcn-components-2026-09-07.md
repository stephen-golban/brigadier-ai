# Git changes panel component references

Verified 2026-09-07. Recommendation: combine the official sidebar-11 file/status pattern, sidebar-02 section hierarchy, compact Item rows, and a unified commit composer. These are presentation references; staging, committing, diff loading, and refresh behavior remain application logic.

| Reference | Verified capability | Proposed use |
| --- | --- | --- |
| [Official sidebar blocks](https://ui.shadcn.com/blocks/sidebar), especially sidebar-11 | The [sidebar-11 registry source](https://ui.shadcn.com/r/styles/new-york/sidebar-11.json) contains a Changes section with file icons and M/U badges, plus a collapsible file tree. | Best overall reference: compact changed-file rows with aligned status badges. Make folder grouping optional. |
| [Official sidebar-02](https://ui.shadcn.com/blocks/sidebar#sidebar-02) | The official block library identifies this as a sidebar with collapsible sections. | Use its grouping pattern for Staged Changes and Changes, with file counts and group actions. |
| [Item](https://ui.shadcn.com/docs/components/radix/item) | Supports title, description, media, actions, grouped lists, and compact `sm`/`xs` sizes. | Filename, muted parent path, change status, and stage/unstage action in a consistent row. Customize spacing for a narrow developer panel. |
| [Input Group](https://ui.shadcn.com/docs/components/radix/input-group) | Provides textarea composition and `block-end` addons containing text or buttons. | One commit-message surface with a bottom toolbar for message generation and relevant helper text. |
| [Button Group](https://ui.shadcn.com/docs/components/radix/button-group#dropdown-menu) | Documents split buttons and composition with Dropdown Menu. | One primary commit button with secondary supported commit variants in the adjacent dropdown. |

The official block library labels its blocks open source and free. The existing project already has Sidebar, Collapsible, Button, Dropdown Menu, Textarea, Command, and Scroll Area according to the coordinating agent's local inspection; reuse those where suitable rather than replacing the panel shell wholesale.

[Community Sidebar File Tree](https://www.shadcn.io/blocks/sidebar-file-tree) is another visual reference: its first-party page describes nested folders, collapsible directories, and active-file highlighting. Its current free versus paid availability was not conclusively verified, so it is not the preferred implementation dependency. The community `command-menu-git` page appeared in search results but repeatedly timed out when opened; exclude it from the verified shortlist.

No application UI changes were made as part of this research.
