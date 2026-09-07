# Intro redesign discussion

## Confirmed direction

On 2026-09-06, after viewing three rendered motion previews, the user selected **B · Cosmic bridge**: “perfect, let's go with B · Cosmic bridge”.

- Deep navy intro with moving blue/violet light.
- Arc-inspired sequence: emerging light, expansion into the window, brand reveal, staggered welcome text, continuation action.
- Settle into a quiet graphite workspace with subtle related accents.
- Collect the user's name during onboarding, as explicitly requested before the palette exploration.

Selected preview: [Cosmic bridge motion reference](assets/cosmic-bridge-motion-reference.mp4).

The video is a discussion concept, not a recording of the application. It uses a temporary Brigadier wordmark, an original synthesized score, sample name entry, and a schematic workspace. The implementation brief below proposes how to carry the selected direction into the app; the implemented vector master is `public/brand/carved-b.svg`.

## Confirmed logo direction

The user selected **1 — Carved B** as the primary logo and explicitly requested retaining **3 — Split B** as the second option. Preserve the backup for later comparison; do not replace the primary with it without a further decision.

[Preserved monogram concept board](assets/brigadier-monogram-options.png): column 1 is the selected Carved B; column 3 is the retained Split B. Column 2 was not selected. This raster board is a visual reference; the selected geometry has now been refined into a vector master and checked at app-icon size.

The board was produced with the built-in imagegen tool. Prompt summary: compare a carved B with a diagonal waist opening, a ribbon B, and a modular split B in monochrome and within the Cosmic bridge intro. A second edit removed presentation glow from the standalone marks while preserving their geometry.

## Interview status

The user requested the grill-me workflow: one decision at a time, with a recommendation, and confirmation of shared understanding before implementation. Palette, primary/backup logo, required name, greetings-only usage, and editing in Settings were confirmed. The user then explicitly approved implementation: “Yes, do it!” The implementation is complete; verification and the remaining native-motion check are recorded in [the implementation report](cosmic-bridge-implementation-2026-09-06.md).

## Confirmed name-entry behavior

The user explicitly clarified: **the name is required**, with no Skip option. This supersedes the earlier mistaken interpretation of optional entry. The name screen has one Continue action and cannot advance with an empty or whitespace-only name. Completing the cinematic intro, including any cinematic skip control, must not bypass required name collection.

The name is used **only for interface greetings**. Do not include it in coding-agent prompts or agent context.

The user also confirmed that the name is editable later in Settings and must remain nonempty.

## Approved implementation brief

1. Rebuild the intro around the selected Cosmic bridge preview: softly deforming light, continuous expansion into the window, Carved B reveal, staggered focus on “Your next idea starts here.”, and a compact arrow action. Use deep navy with moving blue/violet light and restrained cyan highlights.
2. Refine Carved B into a scalable vector master for the intro and app icon. Preserve the Split B concept as a backup. Inspect the primary at actual small icon sizes as well as at intro size.
3. Place “What should we call you?” immediately after the welcome arrow and before project setup. Require a non-whitespace name; provide Continue with no Skip option. Use the actual entered value for the subsequent welcome. The sample typing and automatic transitions in the reference video are demonstration only.
4. Store the name locally with application preferences, with a nonempty editable field in Settings. This local persistence is the proposed implementation default. Use the value for interface greetings only. An interrupted onboarding resumes at required name entry if no name has been saved; an existing completion flag alone cannot bypass it.
5. Carry restrained blue/violet accents into the existing graphite workspace. The schematic workspace in the video demonstrates palette continuity; it is not a replacement layout specification.
6. Use the selected preview's pacing and original ambient sound as the first-use reference. Its 22-second runtime includes demonstration holds, name typing, and the workspace view, so it must not become a fixed loading delay. The welcome and name screens wait for real user input. Preserve launch music preferences and the short returning-user behavior documented in the earlier startup specification.
7. Verify the complete first-use flow, empty-name validation, saved/editable name, interrupted onboarding, returning launches, sound controls, reduced motion, and startup failure recovery. Compare actual macOS captures against the selected motion reference; browser previews alone do not establish native desktop transition quality.
