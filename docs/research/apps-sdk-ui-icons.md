# `@openai/apps-sdk-ui` — the icon set

Researched 2026-09-10. Every claim below is tagged **[measured]** (read in the published tarball, the repo
source, the npm registry JSON, or produced by a command run here) or **[asserted]** (inferred, not verified).

Primary sources used:

- npm registry JSON: `https://registry.npmjs.org/@openai/apps-sdk-ui` and `.../0.2.2`
- The published tarball `apps-sdk-ui-0.2.2.tgz`, downloaded and extracted; `dist/es`, `dist/types`,
  `package.json`, `README.md`, `LICENSE` read directly.
- `https://github.com/openai/apps-sdk-ui` — GitHub REST API for repo metadata, the recursive git tree of `main`,
  and issues; `raw.githubusercontent.com` for `src/Icons.mdx`, `src/components/Icon/index.tsx`, `AGENTS.md`,
  `.storybook-base/components/CustomIconGallery.tsx`.
- **Not** usable: the Storybook at `https://openai.github.io/apps-sdk-ui/?path=/docs/foundations-icons--docs`.
  It is a client-rendered SPA; a plain fetch returns only the shell (`@storybook/core - Storybook`) with no icon
  content. **[measured]** Its icon page is generated at runtime from `Object.entries(Icons)` over the same barrel
  this document enumerates from source, so the source list is the same list. **[measured]** — see
  `.storybook-base/components/CustomIconGallery.tsx`.

---

## 1. Package, version, license

| Fact | Value | Tag |
| --- | --- | --- |
| npm package name | `@openai/apps-sdk-ui` | [measured] |
| Published on npm? | Yes, public, unscoped-readable | [measured] |
| `dist-tags.latest` | **0.2.2** | [measured] |
| All published versions | `0.1.0` (2025-11-20), `0.2.0` (2025-11-23), `0.2.1` (2025-12-01), `0.2.2` (2026-05-05) | [measured] |
| License | **MIT**, `Copyright 2025 OpenAI` in `LICENSE` | [measured] |
| Repository | `github.com/openai/apps-sdk-ui`, default branch `main`, 941 stars, last push 2026-05-20 | [measured] |
| Description | "Design system for building apps for ChatGPT with Apps SDK" | [measured] |
| Weekly downloads | 405,182 (week ending 2026-09-06) | [measured] |
| Tarball size | 4,186,008 bytes unpacked, 2,645 files | [measured] |

`main` is ahead of the last npm release: `AGENTS.md` on `main` documents components (`Animate`, `AnimateLayout`,
`AvatarGroup`, `ButtonLink`, `CopyTooltip`, `Modal`, `TransitionGroup`) that do **not** exist in 0.2.2's
`dist/es/components/`. **[measured]** The icon barrel, however, is byte-for-byte the same set on `main` as in
0.2.2 — 745 exports either way, zero added, zero removed. **[measured]**

There is no GitHub-only distribution channel; npm is the distribution. **[measured]**

---

## 2. How icons are exported

**There is no `@openai/apps-sdk-ui/icons` entry point.** The `exports` map in `package.json` (identical in the
tarball and on `main`) is exactly: **[measured]**

```json
"exports": {
  "./css":         "./dist/es/styles/index.css",
  "./components/*": { "types": "./dist/types/components/*/index.d.ts", "default": "./dist/es/components/*/index.js" },
  "./hooks/*":     { "types": "./dist/types/hooks/*.d.ts",             "default": "./dist/es/hooks/*.js" },
  "./theme":       { ... }, "./helpers": { ... }, "./userAgent": { ... }, "./dateUtils": { ... }
}
```

Icons ship as **one barrel subpath**, `./components/Icon`, holding **named** re-exports of 745 individual
modules. The documented import syntax, verbatim from `src/Icons.mdx` on `main`: **[measured]**

```jsx
import { IconName } from "@openai/apps-sdk-ui/components/Icon"
```

and from the published `README.md`: **[measured]**

```tsx
import { Calendar, Invoice, Maps, Members, Phone } from "@openai/apps-sdk-ui/components/Icon"
```

Under the hood: `dist/es/components/Icon/index.js` is 745 lines, every one of the shape
`export { default as ArrowDown } from "./svg/ArrowDown";`, and nothing else. **[measured]** Each icon is its own
module at `dist/es/components/Icon/svg/<Name>.js` with a `.d.ts` beside it in `dist/types/…`. There are **755**
such module files but only **745** are re-exported (see §5). **[measured]**

No sprite. No individual-file public entry point. **[measured]**

**Deep-importing a single icon does not work.** `@openai/apps-sdk-ui/components/Icon/svg/ArrowDown` resolves
through the `./components/*` wildcard to `dist/es/components/Icon/svg/ArrowDown/index.js`, which does not exist:

```
deep FAIL: ERR_MODULE_NOT_FOUND Cannot find module '…/dist/es/components/Icon/svg/ArrowDown/index.js'
```

**[measured]** — run here against a real `node_modules` install of the 0.2.2 tarball. You can reach an icon only
by bypassing the exports map entirely (`…/dist/es/components/Icon/svg/ArrowDown.js`), which is unsupported and
would be broken by any layout change. Open issues #46 and #48 propose adding an `./icons/*` subpath; neither has
landed. **[measured]**

---

## 3. Standalone components, `currentColor`, props, default size

Each icon module in full — this is the entire `ArrowDown.js`: **[measured]**

```js
import { jsx as _jsx } from "react/jsx-runtime";
const ArrowDown = (props) => (_jsx("svg", { width: "1em", height: "1em", viewBox: "0 0 24 24", fill: "currentColor", ...props, children: _jsx("path", { fillRule: "evenodd", d: "M12.707 18.707a1 1 0 0 1-1.414 0l-5-5a1 1 0 1 1 1.414-1.414L11 15.586V6a1 1 0 1 1 2 0v9.586l3.293-3.293a1 1 0 0 1 1.414 1.414l-5 5Z", clipRule: "evenodd" }) }));
export default ArrowDown;
```

- **Standalone. No CSS, no theme provider, no Tailwind needed.** Across all 755 icon modules the *only* import
  statement of any kind is `react/jsx-runtime`. Zero modules import CSS, tokens, `clsx`, or anything else.
  **[measured]** — `grep -h '^import' dist/es/components/Icon/svg/*.js | sort -u` yields exactly two lines, both
  `react/jsx-runtime`. The icons carry no `className` of their own, so `@openai/apps-sdk-ui/css` and
  `AppsSDKUIProvider` are irrelevant to rendering them. **[measured]**
- **`currentColor`: yes, universally.** 755/755 modules contain `currentColor`; zero lack it. **[measured]**
- **Fill-based, not stroke-based.** 748 of 755 use `fill: "currentColor"` on the `<svg>` with filled paths. Only
  7 use `stroke`: `Bills`, `Dot`, `Flash`, `Graduate`, `PencilSparkle`, `Scales`, `Timer` — and those set
  `stroke="currentColor"`, `fill="none"`, `strokeWidth: 1.5`, `strokeLinecap/Linejoin: "round"` on the path.
  **[measured]** There is no package-wide stroke weight; the set is a filled set with 7 outline exceptions.
- **Props: `SVGProps<SVGSVGElement>`, and nothing more.** The `.d.ts` is:
  `declare const ArrowDown: (props: SVGProps<SVGSVGElement>) => JSX.Element` **[measured]**
  There is **no `size` prop, no `strokeWidth` prop, no `title`/`aria-label` convenience prop.** `className`,
  `style`, `width`, `height`, `onClick`, `aria-hidden` etc. all work because `...props` is spread onto the
  `<svg>` **after** the defaults, so any of `width`/`height`/`viewBox`/`fill` can be overridden. **[measured]**
  `children` is set after the spread, so a `children` prop is silently discarded. **[measured]**
- **Default size: `1em` × `1em`** — the icon inherits the parent's `font-size`. **[measured]** 755/755 modules use
  `width: "1em"`. Sizing is therefore done with a font-size or a utility class; the README's own example uses
  Tailwind's `size-4`: `<Calendar className="size-4" />`. **[measured]** With no Tailwind at all, plain CSS
  (`.icon { width: 16px; height: 16px }` or a `font-size`) works identically. **[asserted]** — follows from the
  attributes, not separately rendered here.
- **viewBox is not uniform.** 730 use `0 0 24 24`; the rest: 12 × `0 0 18 18`, 5 × `0 0 20 20`, 2 × `0 0 21 21`,
  and one each of `0 0 6 6`, `0 0 20 21`, `0 0 18 16`, `0 0 16 9`, `0 0 16 16`, `0 0 10 16`. **[measured]** Because
  `width`/`height` are `1em` regardless, off-grid icons render at the same box but with a different apparent
  optical weight. Names ending `Sm`/`Md`/`Lg`/`Xs` are *separate drawings at different optical sizes*, not size
  props — e.g. `Check`, `CheckMd`, `CheckLg` are three distinct modules. **[measured]**
- **Accessibility: nothing is provided.** No `aria-hidden`, no `role`, no `<title>`. The consumer must add them.
  **[measured]**

---

## 4. Peers, weight, tree-shaking

`peerDependencies` (0.2.2 and `main`, identical): **[measured]**

```json
"peerDependencies": { "react": "^18.0.0 || ^19.0.0", "tailwindcss": "^4.0.10" }
```

- **React 18 or 19.** **[measured]** README: "Apps SDK UI requires **React 18 or 19** and **Tailwind 4**."
- **Tailwind v4 — declared as a hard peer, `^4.0.10`. Tailwind v3 is not supported.** **[measured]** There is no
  `peerDependenciesMeta`, so npm/pnpm will treat `tailwindcss` as required and warn or fail on a project that
  does not have Tailwind 4. **[asserted]** — inferred from the absent `peerDependenciesMeta`, not reproduced with
  an install here.
- **For the icons specifically, Tailwind is a lie of the manifest.** The icon modules import nothing and reference
  no class names, so they render correctly with Tailwind absent. The peer is required for the *rest* of the
  library. **[measured]**
- `dependencies` — 14 runtime deps, all belonging to the component library, none reachable from the icon barrel:
  `clsx`, `lodash`, `luxon`, `radix-ui`, `react-markdown`, `react-merge-refs`, `react-syntax-highlighter`,
  `rehype-katex`, `remark-breaks`, `remark-directive`, `remark-gfm`, `remark-math`, `unist-util-visit`,
  `usehooks-ts`. **[measured]** Note `radix-ui` is the monolithic package — consistent with this repo's own rule.

**Does importing icons pull in the whole library?** No, not at the module-graph level: the `components/Icon`
barrel's transitive graph is 745 files that import only `react/jsx-runtime`. No CSS, no Radix, no markdown stack.
**[measured]**

**Tree-shaking: yes, it works — but `sideEffects` is not declared.** `package.json` has **no `sideEffects` field**
and **no `"type"` field**. **[measured]** Measured with esbuild 0.25.0 against a real install of 0.2.2:

| Entry | Bundled output | `"svg"` elements retained |
| --- | --- | --- |
| `import { ArrowDown, Check } from ".../components/Icon"` | 108 bytes | **2** |
| `import * as Icons from ".../components/Icon"` | 1,007 KB minified | **745** |

**[measured].** So a bundler that does static ESM analysis drops the other 743. Caveats: with
`react/jsx-runtime` marked external, esbuild still emitted 745 redundant `import {jsx} from "react/jsx-runtime"`
statements (~33 KB of dead import lines) because nothing declares the modules side-effect-free; with
`react/jsx-runtime` resolvable, that collapses to nothing. **[measured]** A `sideEffects: false` declaration would
make this robust across webpack configurations; its absence is a real risk for webpack-based consumers.
**[asserted]** — not reproduced with webpack here.

**Barrel cost in dev/test tooling is the practical problem, not bundle size.** Upstream issue #46 reports Vitest
import time of ~3,000 ms for the barrel vs ~2 ms when avoided; issue #48 reports ~960 ms vs ~8 ms for a single
icon in an installed consumer. **[measured]** — these are the issue authors' numbers, read verbatim from the
GitHub API; **not** reproduced here.

---

## 5. The complete icon list — 745 exported names

Source: `dist/types/components/Icon/index.d.ts` in the 0.2.2 tarball, cross-checked line-for-line against
`src/components/Icon/index.tsx` on `main` (identical set, 745 `export { default as … }` lines in both).
**[measured]**

**745 exported names. 755 modules on disk.** The 10 unexported modules are brand marks that exist as files but
are deliberately not in the barrel: `Inkedin`, `Instagram`, `Jira`, `Linear`, `Snapchat`, `Tiktok`, `Wechat`,
`Whatsapp`, `Youtube`, `Zendesk`. **[measured]** (These are still on disk in `dist/es/components/Icon/svg/`, so
they exist but have no supported import path. **[measured]**) The 755th file, `ObjectIcon.tsx`, *is* exported —
renamed on the way out as `Object`, because a module named `Object.tsx` triggered "Object is accessed before
initialized" in Astro; see closed issue #22. **[measured]**

<details>
<summary>All 745 names, alphabetical</summary>

```
AddMember, AddSources, Agent, AgentMode, AllGizmos, AllProductsExplore, Analytics, AnalyzeData, ApiKey,
ApiKeyAdmin, ApiKeyServiceAccount, ApiKeys, Archive, Array, ArrowBottomLeftSm, ArrowBottomRightSm,
ArrowCurved, ArrowCurvedLeft, ArrowCurvedRight, ArrowCurvedRightXs, ArrowCurvedRightXs24px, ArrowDown,
ArrowDownLg, ArrowDownSm, ArrowLeft, ArrowLeftLg, ArrowLeftSm, ArrowRight, ArrowRightLg, ArrowRightSm,
ArrowRotateCcw, ArrowRotateCw, ArrowTopLeftSm, ArrowTopRightSm, ArrowUp, ArrowUpLg, ArrowUpRight,
ArrowUpSm, AspectRatio11, AspectRatio169, AspectRatio34, AspectRatio43, AspectRatio916, Assistant,
Astronout, AtSign, Atom, AutoPairApps, AutoSuggestedEdits, Autocomplete, AvatarFilledProfile,
AvatarProfile, Back10s, Back15s, BackLarge, BackSmall, BackToApp, BackgroundConversation, BalancingScale,
BarChart, BarChartFilled, Batch, Batches, Bell, BellFilled, Beta, Bills, Blend, BlendingCurveSharp,
BlendingCurveSmooth, BlendingCurveSubtle, Bolt, Book, BookBookmark, BookClock, BookClosed, BookOpen,
BookWrench, Boolean, Brain, Branch, BranchAlt, Bug, BuilderProfileCard, BuildingWorkspace, Business,
BusinessFilled, Cabinet, Calendar, CalendarAlt, CalendarToday, Camera, CameraFilledPhoto, CameraPhoto,
CaptionCcOff, CaptionCcOn, CaptionOff, CaptionOn, Card, CaretDown, CaretLeft, CaretRight, CaretUp,
Category, Certificate, Chart, ChartXAxis, ChartYAxis, Chat, ChatCompose, ChatDashedCheckedTemp,
ChatDashedTemp, ChatTemporary, ChatTripleDots, Chats, Check, CheckCircle, CheckCircleDashed,
CheckCircleFilled, CheckLg, CheckMd, ChevronDown, ChevronDownLg, ChevronDownMd, ChevronDownUp,
ChevronDownVector, ChevronLeft, ChevronLeftLg, ChevronLeftMd, ChevronRight, ChevronRightAlt,
ChevronRightLg, ChevronRightMd, ChevronSmallDown, ChevronSmallLeft, ChevronSmallRight, ChevronSmallUp,
ChevronUp, ChevronUpDown, ChevronUpLg, ChevronUpMd, Circle, CircleDashed, CircleQuestion,
ClappingBoardClosed, ClappingBoardOpen, Cleanup, Clear, Click, Clip, Clipboard, ClipboardCopy, Clock,
Clock10s, Clock15s, Clock20s, Clock5s, ClockOff, CloseBold, Code, CodeSquareSlash, Collapse, CollapseLarge,
CollapseLeft, CollapseLg, CollapseRight, CollapseSm, CollapseSmall, ColorTheme, Comment, Commit, Compare,
CompareArrows, Compass, Complete, ComposeCanvasEditStar, ComposeDashedTemporary, ComposeEditSquare,
Confetti, ConfettiParty, Connect, ConnectApps, ConnectedDynamicGpt, ConnectorsConnectedApps, Copy,
CreditCard, Credits, Cube, Cursor, Customize, DarkMode, DataControls, DeepSearchTelescope, Delete,
DeleteAccount, Desktop, DiningEvents, DisabledCursor, Dock, Document, Documentation, DollarCircle, Dot,
DotsHorizontal, DotsHorizontalCircle, DotsHorizontalMoreMenu, DotsVertical, DotsVerticalCircle,
DotsVerticalMoreMenu, DoubleChevronLeft, DoubleChevronRight, Download, DownloadCircle,
DownloadGifWatermark, DownloadSimple, DownloadVideo, DownloadVideoWatermark, Dropdown, DropdownVector,
Dumbbell, EarthTravelWorld, Edit, EditAlt, EditDalleImage, EditPencil, EditStar, EditXs, Education, Email,
EmojiAdd, EmojiLists, EmojiRemove, EmojiSections, EmojiWords, EmptyCircle, EmptyCircleFilled, EnterLogin,
Enum, Equal, Error, ExclamationMarkCircle, ExitLogout, Expand, ExpandLarge, ExpandLg, ExpandMd, ExpandSm,
ExpandSmall, Explore, ExploreSora, ExternalLink, Eye, EyeClosed, EyeOff, FeaturedWreath, File, File3d,
FileAudio, FileBlank, FileCode, FileDocument, FileImage, FilePresentation, FileSpreadsheet,
FileSpreedsheet, FileUpload, FileVideo, FileZip, Filter, FineTuning, FistBump, Flag, Flash, Flask,
FlaskFilled, Folder, FolderDocumentsFinder, FolderOpen, FolderPlus, FolderPlusAdd, FolderShared,
FolderSharedOpen, FolderStuffed, FolderUnshare, Folders, Followup, Forum, Forward, Forward10s, Forward15s,
Frozen, Function, Functions, GenerateSuggestedEdits, Glasses, Globe, GlobeAltRealTimeSearch, GlobeFilled,
GlobeOffRealTimeSearch, GlobeRealTimeSearch, GlobeSpin, Go, GoFilled, Graduate, GraduationCap, Grid,
GridAlt, Group, GroupFilled, Groups, Hamburger, HandBack, HandFront, HandPeace, HandRaised, HandRaisedHey,
HandWavingBye, HapticFeedback, Headphones, Health, Heart, HeartFilled, HeartFilledXs, HeartXs, Help,
History, HistoryOff, HistoryOn, Home, HomeAlt, Identity, IdentityMeSecure, ImageCaption, ImageSquare,
ImageSquarePictureLibrary, ImageToText, ImageWide, ImageWideFilled, ImageWidePictureLibrary, Images, Info,
InfoCircle, Inpaint, InpaintRespond, Inspiration, InspirationFilled, Interactiv, InternalKnowledge,
InternalKnowledgeOptimizedForCircle, Invoice, Io, JumpToCaption, Kettlebell, Key, Keyboard,
KeyboardShortcut, Lab, Language, Latency, Lifesaver, LightMode, Lightbulb, Lightbulb20, Lightbulb22,
Lightbulb22Filled, LightbulbGlow, Link, LinkDisabledBold, LinkExternalWebsite, LocalServices, Lock,
LockKeyHole, Logout, Loop, LoopLong, LoopNormal, LoopShort, LoopXs, Lotus, Love, MagnifyingGlassSearch,
MagnifyingGlassSmSearch, Mail, ManageHistory, MapPin, Maps, MapsAddress, MapsDirections, MarkerCode,
MarkerData, MarkerMultiple, MarkerQuote, Mcp, Members, MembersFilled, MemoryFilledSm, MemoryOffRemember,
MemoryOnRemember, MemoryWriteSm, Menu, MenuInverted, MenuSidebar, Menubar, Messaging, Mic, MicFilled,
MicFilledOff, MicLgDictate, MicOff, MinimizeDown, MinimizeLeft, MinimizeRight, MinimizeTop, Minus,
MinusCircle, MinusCircleFilled, Mobile, Moon, MoonSunSystem, MoreCircleMenuDots, Music, MyGptProfileMe,
Name, NewsPaper, NoTraining, Nodes, Notebook, NotebookCheck, NotebookNarrow, NotebookPencil, Notepad,
NotificationBell, NotificationOffBell, Number, Object, On, OpenLeft, OpenRight, OpenaiLogoBold,
OpenaiLogoBoldBoundingBox, OpenaiLogoRegular, OpenaiLogoRegularBoundingBox, OpenaiLogoWebappVariable480,
Operator, Order, PageBlank, Paid, Paperclip, PaperclipAttach, ParentControl, PastedText, Pause,
PauseCircle, PauseCircleFilled, PauseOutline, PauseSm, Paw, Pencil, PencilSparkle, PencilSquare, Pens,
Phone, PhoneMissed, PhoneRing, PhoneWaves, PictureInPicture, Pin, PinFilled, PinWindow, Plane, PlantDesk,
Play, PlayCircle, PlayCircleFilled, PlayOutline, PlaySm, PlayTriangle, Playground, Plugin, PluginPuzzle,
Plus, Plus14px, PlusCircle, PlusCircleAdd, PlusCircleFilled, PlusComposer, PlusFilled, PlusLg,
PlusLg18pxAdd, PlusSm12px, PlusSquareAdd, PopOutWindow, PresetDefault, PresetSelected, PrivacyIntern,
ProDiamond, ProFilledDiamond, ProductTag, PullRequestClosed, PullRequestDraft, PullRequestMerged,
PullRequestOpen, Pulse, Question, QuestionMark, QuestionMarkCircle, QuickStart, Quote,
QuoteReplyFilledQuoteXs, RadioSelected, ReadingLevel, Record, Regenerate, RegenerateOff, RegenerateStar,
Reload, RemixMild, RemixMildXs, RemixStrong, RemixSubtle, RemoveForeverPermanently, RemoveRedEye, Reply,
Report, Resend, ResetChat, Resolution1080p, Resolution360p, Resolution480p, Resolution720p, RestoreUntrash,
Rewind, Robot, RobotHead, RobotHeadSad, SavedFilledXs, SavedXs, Scales, Scissor, ScissorXs, ScreenPosition,
Search, SearchConnector, SearchFeed, SearchXs, SelectText, Settings, SettingsCircle, SettingsCog,
SettingsSlider, SettingsWrench, Share, ShareChat, ShareScreen, ShareScreenFilled, ShareScreenOff,
ShareScreenOffFilled, ShieldCheck, ShieldKey, ShieldLock, ShieldPerson, ShoppingBag, Shortcuts, Shuffle,
Sidebar, SidebarCollapseLeft, SidebarCollapseRight, SidebarFloatingLeft, SidebarFloatingOpenLeft,
SidebarFloatingOpenRight, SidebarFloatingRight, SidebarLeft, SidebarMenuMobile,
SidebarMenuMobileBadgeCutout, SidebarOpenLeft, SidebarOpenLeftAlt, SidebarOpenRight, SidebarOpenRightAlt,
SidebarRight, SimpleRelax, SimpleSad, SimpleSmile, Skip, Sleep, Snorkle, Snowflake, SoraBasicPopcorn,
SoraProDirector, SoundOffSimpleMute, SoundOffSpeaker, SoundOnReadOutLoudSpeaker, Sparkle, SparkleDouble,
SparkleFilledPlus, SparklePlus, Sparkles, SparklesFilled, Speak, SpeechToText, Speed,
SpeedometerLatencySpeed, Spelling, Spin, SquareCheckCheckboxChecked,
SquareCheckFilledCheckboxCheckedFilled, SquareCheckboxUnchecked, SquareCode, SquareFilledTableLegend,
SquareImage, SquarePlus, SquarePlusAlt, SquareTableLegend, SquareText, Stack, Star, StarFilled,
StartStrokeMd, Status, Stethoscope, StickyNote, Stop, StopCircle, StopCircleFilled, StopOutline, StopSm,
StopStrokeMd, Stopwatch, Storage, Storyboard, String, Studio, Stuff, StuffTools, SubscriptionPlan,
SuggestEdit, Suitcase, SuitcaseFilledWorkBusiness, SuitcaseWorkBusiness, Sun, SystemMode, TBoneRaw,
TableCellFilled, TableCellsFilled, TableColumnFilled, TableFilled, TableRowFilled, Tag, Tap, Tasks,
Telescope, Terminal, TerminalLg, Terms, Text, TextLonger, TextPrompt, TextShorter, TextShorterConcise,
TextToSpeech, ThumbDown, ThumbDownFilled, ThumbMixed, ThumbUp, ThumbUpFilled, ThumbnailLarge,
ThumbnailMedium, ThumbnailSmall, Thumbs, Timer, Tools, ToolsSkills, Translate, Trash, TrashRemove,
Trending, TriangleExclamationErrorWarning, TriangleExclamationFilledErrorWarning, TrophyTop, TuningFork,
Unarchive, Undo, Unlink, Unpin, Upgrade, UpgradePlan, UploadDocuments, Upscale, UpscaleXs, Usage, User,
UserAdd, UserGpts, UserHeart, UserLock, UserVoice, Users, Variation2v2, VariationV21, VariationV31,
VariationV32, VariationV33, VariationV41, VariationV42, VariationV43, VariationV44, VersionsV1, Video,
VideoCaption, VideoFilled, VideoFilledOff, VideoGrid, VideoList, VideoToText, Videos, Voice, Voice4Bars,
Voice5BarsSoundwave, VoiceBold, VoiceInputAreaMobileFilledVoiceXs, VoiceLight, Warning,
WarningFilledWrapCenteredForCircle, WarningWrapCenteredForCircle, Wave, WebsiteNetwork, Whisk,
WhisperAutoSubmit, Widget, WidgetAdd, WorkWithApps, Workspace, Wreath, WriteAlt, WriteAlt2, Writing, X,
XCircle, XCircleCrossedClose, XCircleFilled, XCircleFilledCrossedClose, XCrossed, XSquareCrossed,
XSquareFilledCrossed, XXs, XXsCrossed
```

</details>

---

## 6. Coverage check against common UI needs

Verdicts below are name-matching over the 745-name list **[measured]**; where a name is ambiguous I opened the
SVG path data and say so. "Closest" means a plausible substitute, not an exact equivalent.

| Need | Verdict | Name(s) |
| --- | --- | --- |
| chevron down/up/left/right | **yes** | `ChevronDown`, `ChevronUp`, `ChevronLeft`, `ChevronRight` (+ `…Sm/Md/Lg`, `ChevronSmall*`, `ChevronUpDown`, `ChevronDownUp`, `DoubleChevronLeft/Right`) |
| arrow up/down/left/right | **yes** | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` (+ `…Sm/Lg`, `ArrowTopLeftSm` etc., `ArrowUpRight`) |
| check | **yes** | `Check`, `CheckMd`, `CheckLg`, `CheckCircle`, `CheckCircleFilled`, `CheckCircleDashed` |
| x / close | **yes** | `X`, `XXs`, `CloseBold`, `XCircle`, `XCircleFilled`, `XSquareCrossed` |
| plus | **yes** | `Plus`, `PlusLg`, `PlusSm12px`, `PlusCircle`, `PlusFilled`, `SquarePlus` |
| minus | **yes** | `Minus`, `MinusCircle`, `MinusCircleFilled` |
| search | **yes** | `Search`, `SearchXs`, `MagnifyingGlassSearch`, `MagnifyingGlassSmSearch` |
| settings / gear | **yes** | `Settings`, `SettingsCog`, `SettingsCircle`, `SettingsSlider`, `SettingsWrench` (no name contains "Gear") |
| folder | **yes** | `Folder`, `FolderOpen`, `Folders`, `FolderPlus`, `FolderStuffed`, `FolderShared` |
| file | **yes** | `File`, `FileBlank`, `FileCode`, `FileDocument`, `FileImage`, `FileZip`, `FileSpreadsheet`, … |
| terminal | **yes** | `Terminal`, `TerminalLg` |
| git branch | **yes** | `Branch`, `BranchAlt` — path data is three 2.5-radius circles joined by curves, i.e. the standard git-branch glyph **[measured]**. Also `Commit`, `PullRequestOpen`, `PullRequestClosed`, `PullRequestDraft`, `PullRequestMerged`. No `Fork`, no `Merge` (only `PullRequestMerged`), no GitHub mark. |
| copy | **yes** | `Copy`, `ClipboardCopy` |
| trash | **yes** | `Trash`, `TrashRemove`, `Delete`, `RemoveForeverPermanently`, `RestoreUntrash` |
| edit / pencil | **yes** | `Edit`, `EditAlt`, `EditXs`, `EditPencil`, `Pencil`, `PencilSquare`, `PencilSparkle` |
| play | **yes** | `Play`, `PlaySm`, `PlayOutline`, `PlayCircle`, `PlayCircleFilled`, `PlayTriangle` |
| pause | **yes** | `Pause`, `PauseSm`, `PauseOutline`, `PauseCircle`, `PauseCircleFilled` |
| stop | **yes** | `Stop`, `StopSm`, `StopOutline`, `StopStrokeMd`, `StopCircle`, `StopCircleFilled` |
| refresh / reload | **yes** | `Reload`, `ArrowRotateCw`, `ArrowRotateCcw`, `Regenerate`, `Loop` (no name contains "Refresh" or "Sync") |
| external link | **yes** | `ExternalLink`, `LinkExternalWebsite` |
| loader / spinner | **NO icon** | Closest: the `Indicator` **component** — `AGENTS.md` describes it as "Loading dots and circular progress indicators" **[measured]**, but it is not in 0.2.2's `dist/es/components/` **[measured]**. `Spin`/`GlobeSpin` exist but `Spin` is a 5-lobed cluster of overlapping circles, decorative, not a spinner ring **[measured, path data]**. `Pulse` also exists **[asserted]**. |
| alert / warning | **yes** | `Warning`, `WarningFilledWrapCenteredForCircle`, `TriangleExclamationErrorWarning`, `TriangleExclamationFilledErrorWarning`, `Error`, `ExclamationMarkCircle` (no name contains "Alert") |
| info | **yes** | `Info`, `InfoCircle` |
| circle-dot / status | **yes** | `Dot`, `Circle`, `CircleDashed`, `EmptyCircle`, `EmptyCircleFilled`, `Status`, `Indicator`-adjacent none |
| clock | **yes** | `Clock`, `ClockOff`, `Clock5s/10s/15s/20s`, `Timer`, `Stopwatch`, `History` |
| eye / eye-off | **yes** | `Eye`, `EyeOff`, `EyeClosed`, `RemoveRedEye` |
| more-horizontal / vertical | **yes** | `DotsHorizontal`, `DotsVertical`, `DotsHorizontalCircle`, `DotsVerticalCircle`, `DotsHorizontalMoreMenu`, `DotsVerticalMoreMenu`, `MoreCircleMenuDots` |
| sidebar toggle | **yes**, 16 variants | `Sidebar`, `SidebarLeft`, `SidebarRight`, `SidebarOpenLeft/Right`, `SidebarCollapseLeft/Right`, `SidebarFloating*`, `MenuSidebar` |
| maximize / minimize | **partial** | `Minimize{Down,Left,Right,Top}` exist; **no `Maximize`, no `Fullscreen`, no `Zoom`, no `Enlarge`, no `ArrowsOut`/`ArrowsIn`, no `Shrink`** — checked name by name against the 745 **[measured]**. Closest for "maximize": `Expand`, `ExpandSm`, `ExpandSmall`, `ExpandMd`, `ExpandLg`, `ExpandLarge`. Beware the pairing: `Collapse` is **not** `Expand`'s mirror — `Expand` is two corner brackets near the centre, `Collapse` two opposing chevrons **[measured, path data]**. The mirrored pairs are `ExpandSmall`/`CollapseSmall` and `ExpandSm`/`CollapseSm` (brackets moved to the outer corners, pointing in) and `ExpandLarge`/`CollapseLarge`, `ExpandLg`/`CollapseLg` (diagonal arrows out vs in) **[measured, path data]**. `Expand`'s path is byte-identical to `ExpandSmall`'s, so `Expand`/`CollapseSmall` is that pair under the shorter alias **[measured]**. `PopOutWindow`, `PinWindow`, `PictureInPicture` also exist. |
| send | **NO** | No `Send`, no `PaperPlane`, no `Submit`. Closest: `ArrowUp` (ChatGPT's own composer glyph) **[asserted]**, or `Plane` — whose path is a tilted airplane silhouette, a travel icon, not a send arrow **[measured, path data]**. `Reply`, `Forward`, `Resend`, `Share` exist. |
| paperclip / attachment | **yes** | `Paperclip`, `PaperclipAttach`, `Clip` |
| sun / moon (theme) | **yes** | `Sun`, `Moon`, `MoonSunSystem`, `DarkMode`, `ColorTheme` |
| user | **yes** | `User`, `Users`, `UserAdd`, `UserLock`, `UserHeart`, `AvatarProfile`, `AvatarFilledProfile`, `Group`, `Groups` |
| keyboard | **yes** | `Keyboard`, `KeyboardShortcut`, `Shortcuts` |
| lock | **yes**, one-way | `Lock`, `LockKeyHole`, `ShieldLock`, `UserLock`. **No unlocked/open-padlock icon** — no `Unlock`, no `LockOpen`. |
| filter | **yes** | `Filter` — one only. **No `Sort`, no `Reorder`, no drag-handle/grip icon.** |
| download | **yes** | `Download`, `DownloadSimple`, `DownloadCircle`, `DownloadVideo` |
| upload | **partial** | **No plain `Upload`.** Closest: `FileUpload`, `UploadDocuments`. `ArrowUp` as a fallback **[asserted]**. |
| code | **yes** | `Code`, `SquareCode`, `FileCode`, `CodeSquareSlash`, `MarkerCode` |
| list | **partial** | **No plain `List`, no bullet/ordered/checklist icon.** Closest: `Tasks`, `VideoList`, `EmojiLists`, `Order`, `Menu`, `Stack`. |
| grid | **yes** | `Grid`, `GridAlt`, `VideoGrid` |
| home | **yes** | `Home`, `HomeAlt` |
| bell | **yes** | `Bell`, `BellFilled`, `NotificationBell`, `NotificationOffBell` |
| star | **yes** | `Star`, `StarFilled`, `EditStar`, `RegenerateStar` |
| bookmark | **partial** | Only `BookBookmark` — no standalone ribbon-bookmark named `Bookmark`. **[measured]** `Pin`, `PinFilled`, `Unpin`, `Flag` are alternatives. |
| tag | **yes** | `Tag`, `ProductTag` |
| hash | **NO** | No `Hash`, no `Pound`, no `NumberSign`. Closest: `Number` — a rounded square containing a glyph **[measured, structure only; the inner glyph was not identified]**. |
| message / chat | **yes** | `Chat`, `Chats`, `ChatCompose`, `ChatTripleDots`, `Comment`, `Forum`, `Reply`, `BackgroundConversation`. **No name contains "Message" or "Bubble".** |
| sparkles | **yes** | `Sparkle`, `Sparkles`, `SparklesFilled`, `SparkleDouble`, `SparklePlus`, `SparkleFilledPlus`, `PencilSparkle` |
| brain / cpu | **partial** | `Brain` yes. **No `Cpu`, no `Chip`, no `Processor`.** Closest for compute: `Atom`, `Nodes`, `Robot`, `RobotHead`, `Agent`, `Mcp`. |
| zap | **yes** | `Bolt` (filled lightning bolt **[measured, path data]**), `Flash` (stroke lightning bolt, `strokeWidth: 1.5` **[measured]**) |
| database | **yes (by drawing, not by name)** | `Storage` — path is a stacked-cylinder database can **[measured, path data]**. No name contains "Database" or "Server". |
| globe | **yes** | `Globe`, `GlobeFilled`, `GlobeSpin`, `GlobeAltRealTimeSearch`, `GlobeOffRealTimeSearch`, `EarthTravelWorld`, `Compass` |
| link | **yes** | `Link`, `Unlink`, `ExternalLink`, `LinkDisabledBold` |
| undo / redo | **half** | `Undo` yes — a left-pointing curved arrow **[measured, path data]**. **No `Redo`.** Mirror `Undo` with `transform: scaleX(-1)` **[asserted]**, or use `Forward` / `ArrowRotateCw`. |
| scissors | **NO** | No `Scissors`, no `Cut`, no `Crop`, no `Trim`. No substitute. |
| image | **yes** | `ImageSquare`, `ImageWide`, `ImageWideFilled`, `Images`, `FileImage`, `SquareImage`, `CameraPhoto`, `CameraFilledPhoto` |

**Summary of the outright misses:** `send`, `hash`, `scissors`, `redo`, `sort`, `maximize`/`fullscreen`,
`unlock`, `cpu`, and a true `loader`/`spinner`. **Partial misses** (only a compound-named variant exists):
`upload`, `list`, `bookmark`. **[measured]**

**Note on what the set *is*:** it is ChatGPT's product icon set, not a general-purpose developer set. It carries
`Mcp`, `Agent`, `AgentMode`, `Whisper*`, `MyGptProfileMe`, `UserGpts`, `ConnectedDynamicGpt`, `MemoryOnRemember`,
`Upscale`, `DownloadGifWatermark`, `Dalle`-adjacent names, and 10 unexported social brand marks. **[measured]**
The developer-tooling corner (git, terminal, code) is thin but present; the ChatGPT-surface corner is deep.

---

## 7. Adding a custom icon in the same style

**There is no documented icon-wrapper component and no published SVG convention doc.** **[measured]**

- `src/components/Icon/index.tsx` is exclusively 745 re-export lines — there is no `<Icon>` wrapper, no
  `createIcon` helper, no `IconProps` type exported. **[measured]**
- `src/Icons.mdx` (the Storybook "Foundations/Icons" page source, fetched raw) contains only a title, a one-line
  usage snippet, and `<CustomIconGallery />`. No conventions, no contribution guidance for icons. **[measured]**
- `AGENTS.md` on `main` lists `Icon` in the component table as "Collection of SVG icons exported as React
  components" and gives file-naming conventions for *components*, but says nothing about drawing an icon.
  **[measured]** Open issues #47 and #17 both ask for the missing Storybook docs for `Icon`. **[measured]**
- There is no SVGR config, no icon-generation script — `scripts/` contains only `build-css.mjs`, and all 755
  icons are hand-committed `.tsx` files under `src/components/Icon/svg/`. **[measured]**

**The conventions, reverse-engineered from the 755 modules — follow these to match the style:** **[measured]**

```tsx
import type { SVGProps } from "react"

const MyIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path fillRule="evenodd" d="…" clipRule="evenodd" />
  </svg>
)
export default MyIcon
```

- 24×24 viewBox (730/755), `width`/`height` of `1em`, `fill="currentColor"` on the `<svg>`, `{...props}` spread
  after the defaults, single default export, no `className` of its own, no `aria-*`.
- For the outline style used by the 7 stroke icons: `fill="none"` plus `stroke="currentColor"`,
  `strokeWidth={1.5}`, `strokeLinecap="round"`, `strokeLinejoin="round"` on the path.
- A custom icon written this way is a drop-in sibling — nothing in the package needs to know about it, because
  the icons have no shared runtime. **[measured]**

---

## 8. Known issues and landmines

Open upstream issues, read from the GitHub API on 2026-09-10 **[measured]**:

| # | State | Title / substance |
| --- | --- | --- |
| **39** | open | **"Module is not ESM compliant."** Two concrete defects, quoted: the package "builds ESM into `dist/es`, but the file extensions of those files are `.js`. The `package.json` does not include `"type": "module"`, so the files are interpreted as CJS"; and "Local/relative imports in the `dist` output do not include file extensions which means that Node cannot resolve them." |
| **40** | open | PR fixing #39 by rebuilding with `tsdown`. Not merged. |
| **46** | open | Barrel import cost in Vitest: ~3,000 ms vs ~2 ms. Asks for `./icons/*` subpath exports. |
| **48** | open | PR adding `"./icons/*"` to `exports`. Reports ~960 ms → ~8 ms for a single icon. Not merged. |
| **47**, **17** | open | Missing Storybook docs for `Image` and `Icon`. |
| **20** | open | "Add CommonJS support" — there is no CJS build at all. |
| **37** | open | "Is the project maintained?" — filed against a 2-month commit gap. Last npm release 2026-05-05; last push to `main` 2026-05-20. |
| **22** | closed | Astro: "Object is accessed before initialized" — resolved by renaming the module `ObjectIcon.tsx` while keeping the export name `Object`. |

**Issue #39 reproduced here, independently. [measured]** Installing the 0.2.2 tarball into a real
`node_modules` and importing the barrel from Node 24 with `"type": "module"`:

```
FAIL: ERR_MODULE_NOT_FOUND Cannot find module
  '…/dist/es/components/Icon/svg/AddMember' imported from
  '…/dist/es/components/Icon/index.js'
```

The barrel's `export … from "./svg/AddMember"` has no `.js` extension, which Node's ESM resolver requires. So:

- **SSR / Node-side rendering of these icons does not work without a bundler.** Next.js server components,
  a Node test runner using native resolution, or any `node --import` path will fail this way. **[measured]**
- Bundlers (esbuild, Vite's own transforms, webpack, Rollup with `@rollup/plugin-node-resolve`) resolve
  extensionless relative imports by default and are unaffected in the browser build. Verified with esbuild
  0.25.0 here **[measured]**; Vite and webpack were **not** tested here, and issue #39 claims Vite "will fail to
  resolve" in some configurations **[measured, as a quote — not reproduced]**.
- **No CJS build.** `require("@openai/apps-sdk-ui/components/Icon")` has no target in the exports map. **[measured]**
- **Type declarations exist and are correct** — `dist/types/components/Icon/index.d.ts` plus one `.d.ts` per
  icon, wired through the `types` condition. Not a gap. **[measured]**
- **No `sideEffects: false`.** See §4. **[measured]**

### Biggest landmine, for this repo

**The 745-export barrel is the only supported import path, and it is not resolvable by Node.** In a Tauri/Vite
app the browser bundle is fine and tree-shakes to just the icons used **[measured]**, but any Vitest run or
Node-side tooling that touches the barrel pays either an outright `ERR_MODULE_NOT_FOUND` or, per issue #46, a
multi-second import. The mitigation that does not depend on OpenAI merging #48: **copy the handful of icon
`.tsx` files you need into the repo.** They are MIT, self-contained, and import nothing but `react/jsx-runtime`
**[measured]** — vendoring 20 of them costs ~20 KB of source and removes the peer on `tailwindcss@^4`, the
745-module barrel, and the ESM defect in one move. **[asserted]** — that is a judgement, not a measurement.

### What was not checked

- The live Storybook's rendered content (SPA, not fetchable); icon *appearance* was never viewed, only path data.
- Whether Vite specifically fails to resolve the barrel (issue #39's claim) — not reproduced.
- webpack tree-shaking behaviour without `sideEffects: false` — not reproduced.
- Whether an `npm install` actually errors or merely warns on a Tailwind-v3 or Tailwind-less project.
- The inner glyph of `Number`, and what `Spin`, `Status`, `Stack`, `Loop` and `Pulse` depict beyond their path
  structure.
- Anything about versions newer than 0.2.2 / `main` at 2026-05-20.

---

## 9. Vendoring recipe — what this repo actually did (2026-09-10)

The package is a **devDependency only** (`@openai/apps-sdk-ui@^0.2.2`). Nothing under `src/` imports it at
runtime; §8's ESM defect is real and would break Vitest. `scripts/vendor-icons.mjs` (`npm run vendor:icons`)
copies the icons we use into `src/icons/`, and the app imports only from there.

**How the generator works.** Each `dist/es/components/Icon/svg/<Name>.js` is one arrow function whose body is a
`_jsx`/`_jsxs` call tree. The script strips the `import`/`export default` lines, evaluates the remainder with
`_jsx`/`_jsxs` bound to a shim that returns plain `{ type, props }` objects, and prints the resulting tree back
out as JSX. There is no regex over markup and no transcription step, so the SVG is the package's own element for
element and attribute for attribute. Verified: `npx tsc --noEmit` = 0, `npm test` = 538 passed.

**Inputs and outputs.**

| Path | Role |
| --- | --- |
| `src/icons/manifest.json` | sorted array of apps-sdk-ui export names; the only file edited by hand |
| `src/icons/<Name>.tsx` | one generated component each, regenerated wholesale on every run |
| `src/icons/index.ts` | generated named re-exports plus `export type IconComponent` |
| `src/icons/LICENSE.md` | the package's MIT text and copyright |

**Two deliberate departures from upstream source:**

1. `data-icon="<kebab-name>"` on every `<svg>` root, placed **before** `{...props}` so a caller can override it.
   Tests target that attribute instead of a library's own class name — which is exactly what made
   `WorkTrace.test.tsx`'s `.lucide-check` assertion break on a library swap.
2. An explicit `(props: SVGProps<SVGSVGElement>)` annotation, since upstream ships `.js` with a sibling `.d.ts`.

**Adding an icon:** append the apps-sdk-ui export name to `src/icons/manifest.json`, keep the array sorted, run
`npm run vendor:icons`. The script fails loudly on an unsorted manifest or an unknown name. It deletes every
`.tsx` in `src/icons/` first, so a name dropped from the manifest cannot linger.

**Landmines carried into this repo:**

- Icons render at `1em`, not lucide's 24px and not phosphor's 24px viewBox at `1em`. Every call site is either
  sized by CSS (`src/index.css`'s `.button[data-icon-button="standard"] svg`, `controls/button.tsx`'s
  `[&_svg]:size-4`, `.blur-menu [role="menuitem"] > svg`) or carries a `size-*` class / explicit `width`+`height`.
- There is **no `size` prop.** `size={16}` is a type error; use `width={16} height={16}` or a `size-4` class.
- There is **no `weight` prop.** Phosphor's `weight="fill"` has no equivalent; where a filled variant exists it is
  a separate export (`Pin` / `PinFilled`, `Bell` / `BellFilled`), and where it does not, one glyph carries both
  states.
- The set is fill-based, not stroke-based. `strokeWidth` on a call site is a silent no-op; those were dropped.

---

## 10. Migration mapping — lucide-react and @phosphor-icons/react → vendored apps-sdk-ui

Mapped **per source**, never per name: `CheckIcon`, `FileTextIcon`, `XIcon`, `SearchIcon`, `FolderIcon` and
`ChevronDownIcon` each existed in more than one library, and `Sidebar.tsx` / `WorkspaceTools.tsx` mixed sources
within a single file.

### From `lucide-react`

| lucide name | vendored name | note |
| --- | --- | --- |
| `Archive` | `Archive` | |
| `ArchiveRestore` | `Unarchive` | |
| `ArrowDownIcon` | `ArrowDown` | |
| `ArrowLeft` / `ArrowRight` | `ArrowLeft` / `ArrowRight` | `strokeWidth={1.5}` dropped (fill-based set) |
| `ArrowUpIcon` | `ArrowUp` | |
| `ArrowUpRight` | `ArrowUpRight` | |
| `BotIcon` | `Robot` | |
| `BookOpenIcon` | `BookOpen` | |
| `Check` / `CheckIcon` | `Check` | |
| `ChevronDown` / `ChevronDownIcon` | `ChevronDown` | |
| `ChevronRight` / `ChevronRightIcon` | `ChevronRight` | |
| `CircleAlertIcon` | `ExclamationMarkCircle` | |
| `Columns2` | `SidebarRight` | **gap** — no split-pane glyph; nearest divided-rectangle |
| `CopyIcon` | `Copy` | |
| `EllipsisIcon` | `DotsHorizontal` | |
| `FileTextIcon` | `FileDocument` | |
| `Folder` | `Folder` | |
| `Folders` | `Folders` | |
| `GitBranch` | `Branch` | |
| `GlobeIcon` | `Globe` | |
| `Laptop` | `Desktop` | |
| `ListFilter` | `Filter` | |
| `Maximize2` / `Minimize2` | `Expand` / `CollapseSmall` | **gap** — no `Maximize`/`Fullscreen` in the set. Not `Collapse`: it is opposing chevrons, not `Expand`'s brackets. `CollapseSmall` is the mirror (`Expand` ≡ `ExpandSmall` by path) **[measured, path data]** |
| `MessageCircleIcon` | `Chat` | |
| `MoreHorizontal` | `DotsHorizontal` | |
| `PencilIcon` | `Pencil` | |
| `Plus` | `Plus` | |
| `RefreshCwIcon` | `ArrowRotateCw` | |
| `Search` / `SearchIcon` | `Search` | |
| `Settings` | `Settings` | |
| `ShieldCheckIcon` | `ShieldCheck` | |
| `Tag` | `Tag` | |
| `Telescope` | `Telescope` | |
| `Terminal` / `TerminalIcon` | `Terminal` | |
| `TerminalSquare` | `TerminalLg` | |
| `ThumbsUpIcon` / `ThumbsDownIcon` | `ThumbUp` / `ThumbDown` | |
| `Trash2` | `Trash` | |
| `WorkflowIcon` | `Nodes` | **gap** — no workflow glyph; nearest node-graph |
| `X` / `XIcon` | `X` | |

### From `@phosphor-icons/react`

| phosphor name | vendored name | note |
| --- | --- | --- |
| `ArrowClockwiseIcon` | `ArrowRotateCw` | |
| `ArrowCounterClockwiseIcon` | `ArrowRotateCcw` | |
| `ArrowLeftIcon` | `ArrowLeft` | |
| `ArrowSquareOutIcon` | `ExternalLink` | |
| `ArrowsClockwiseIcon` | `Loop` | |
| `ArrowsOutSimpleIcon` | `Expand` | |
| `ArrowUUpLeftIcon` | `Undo` | |
| `BracketsCurlyIcon` | `Code` | **gap** — no brackets glyph |
| `BugIcon` | `Bug` | |
| `CaretDownIcon` / `CaretRightIcon` | `ChevronSmallDown` / `ChevronSmallRight` | **corrected 2026-09-10.** First mapped to `CaretDown` / `CaretRight`, which are **filled triangles** in this set, not phosphor's chevron-shaped carets; the owner rejected them on sight. `ChevronSmall*` is the optical match: its path spans 39% × 22% of the 24-unit box against `CaretDown`'s 42% × 25%, so the same `size-3` / `width={12}` call site keeps its footprint **[measured, path data]**. Plain `ChevronDown` spans 64% × 31% and is the 16px-box choice; `SourceControl.tsx`'s icon-only commit-options button takes it. `CaretDown` / `CaretRight` now have no consumer and left `src/icons/manifest.json`. |
| `CheckIcon` | `Check` | |
| `FileIcon` | `File` | |
| `FileCode/Css/Html/Image/Js/Jsx/Md/Py/Rs/Text/Ts/TsxIcon` | `File` | 13 per-language glyphs collapse to one; the per-language hex colour is kept |
| `FolderIcon` | `Folder` | |
| `GearSixIcon` | `SettingsCog` | |
| `GitBranchIcon` | `Branch` | |
| `GitDiffIcon` | `Compare` | **gap** — no git-diff glyph |
| `HammerIcon` | `Tools` | **gap** — no hammer |
| `HandPalmIcon` | `HandRaised` | |
| `LaptopIcon` | `Desktop` | |
| `LightningIcon` | `Bolt` | |
| `MinusIcon` | `Minus` | |
| `NotebookIcon` | `Notebook` | |
| `PencilSimpleIcon` | `Pencil` | |
| `PlusIcon` | `Plus` | |
| `RobotIcon` | `Robot` | |
| `ShieldWarningIcon` | `Warning` | **gap** — no shield-warning; the warning triangle carries it |
| `SlidersHorizontalIcon` | `SettingsSlider` | |
| `SparkleIcon` | `Sparkle` | |
| `SunIcon` | `Sun` | |
| `TerminalWindowIcon` | `Terminal` | |
| `UsersThreeIcon` | `Users` | |
| `XIcon` | `X` | |
| `type Icon` | `type IconComponent` | local alias exported from `src/icons/index.ts` |

### From the deleted hand-written modules

| module → export | vendored name | note |
| --- | --- | --- |
| `icons.tsx` → `SendIcon` | `ArrowUp` | **gap** — the set has no `Send`; ChatGPT's own composer uses the up-arrow |
| `icons.tsx` → `ProjectIcon`, `PathIcon`, `ModelIcon` | — | dead code, deleted with no replacement |
| `NavigationIcons.tsx` → `SidebarIcon` | `Sidebar` | |
| `NavigationIcons.tsx` → `FolderIcon` / `FolderOpenIcon` | `Folder` / `FolderOpen` | |
| `NavigationIcons.tsx` → `MoreIcon` | `DotsHorizontal` | |
| `NavigationIcons.tsx` → `PinIcon filled={…}` | `Pin` / `PinFilled` | one prop becomes two glyphs |
| `SearchIcon.tsx` → `SearchIcon` | `Search` | |
| `EditIcon.tsx` → `EditIcon` | `Edit` | |
| `ArchiveIcon.tsx` → `ArchiveIcon` | `Archive` | |
| `BellIcon.tsx` → `BellIcon` | `Bell` | |
| `NotesIcon.tsx` → `NotesIcon` | `Notepad` | |
| `Feed.tsx` local `LinesMark` | `Menu` | **gap, kept** — the mark was three left-aligned lines of decreasing length (`M4 8h20M4 14h15M4 20h9`). The set has no `AlignLeft`, `TextAlignLeft`, `TextLeft`, `Paragraph`, `List` or `Lines` — checked name by name against the 745 **[measured]**. The only left-aligned rule stacks are `Menu` (two lines, decreasing), `Hamburger` (three lines, all equal length) and `MenuInverted` (second line right-aligned) **[measured, path data]**; `Text` is a "T" plus rules, a formatting mark. `Menu` keeps the tapering the original had and loses one line, which is the closest of the three. Renders at 28px, as the hand-written mark did. |
| `Feed.tsx` local `ChevronDownIcon` | `ChevronDown` | |

### Unicode glyph buttons replaced

| site | was | now |
| --- | --- | --- |
| `SourceControl.tsx` sort menu (×2) | `"✓"` string | `<Check className="ml-auto size-3.5" />` |
| `VscodePanels.tsx` dismiss error | `×` | `<X className="size-3.5" />` |
| `PromptInput.tsx` remove attachment (×2) | `×` | `<X className="size-3.5" />` |
| `Composer.tsx` remove queued message | `×` | `<X className="size-3.5" />` |

Keyboard glyphs (`⌘K`, `⌥⌘R`, …) were left alone, as were the CSS-drawn `.composer-spinner` /
`.composer-stop-symbol` and `SessionStatus`'s inline progress circle — the set has no spinner (§6).
