---
name: lvx-ui-design
description: Improve LVX in Radio's interface while preserving its analog-radio identity. Use for layout, typography, icons, canvas/WebGL visuals, animation, notifications, setup, sharing, Electron window sizing or menu-bar UI changes in this repository.
---

# LVX UI design

Read `AGENTS.md`, the private `todo.md` if present, and the applicable UI section of `CLAUDE.md`.
Treat the current rendered app and `src/ui/assets/on-air.css` as the visual baseline.
The user's requested change wins over the baseline when deliberately changing it.

## Design language

Build a tactile radio: almost-black warm surfaces, ivory text, amber focus and
subtle genre colours. Reuse Space Grotesk for human-facing text and JetBrains Mono
for frequencies, labels and measurements. Draw icons as fine rings, waveform
strokes, orbital marks and small light points. Keep small glyphs legible at their
actual size; use SVG/CSS/canvas instead of introducing an unrelated icon library.
Keep the spelling **LVX in Radio**, **LVX EDM**, **LVX Rock**, **LVX Pop**, **LVX Relax**. Technical
`lux-*` ids, file names and stored data paths remain stable.

The semicircular tuner and station identity lead On air; the song list supports
it. Every power control has a left or central physical-looking button and a clear
ON/OFF state. Match With vocals and Describe it in words rather than inventing a
new toggle. Disabled LVX-station controls remain visible and explain why.

Keep motion soft and audio-led. Respect reduced motion, dim behind text, preserve
coloured dust and readable frequency labels. A new effect should survive playback,
pause, a quiet passage and GPU contention without covering controls.

## Working method

1. Inspect existing markup, bindings and styles before editing. `index.html` uses
   dc-runtime: `renderVals()` must supply every `{{ value }}`; exceptions blank the
   entire UI. Vendored runtime files and `POC/` are reference material, not sources
   to rewrite. Prefer scoped additions to the stylesheet.
2. Change the smallest coherent component. Put substantial canvas/SVG behavior in
   an asset module rather than expanding the inline component unnecessarily.
3. Check browser and actual Electron views when shell/layout behavior changes.
   Create expands the native window and On air restores its size. Smaller windows
   must fit all Create controls, including Tune In and the footer, without page
   scrollbars. Do not disguise clipping by merely hiding overflow.
4. Inspect screenshots at normal size and at 1120 × 720. Test the actual clicks,
   disabled states and keyboard focus, check the console, and verify that labels
   cannot move the FM scale while dragging. State what was visually verified.
5. For QR styling, save and decode real images, including long codes, voices and
   instrumental settings. Style must preserve machine readability.

## Product details to preserve

- Setup appears before Create when required; LVX playback keeps running.
- Notifications stack to the left below New station, clear of the tuner and
  transport. Create notices stay inside the native window while it changes size.
- Completing a song elsewhere asks where to listen; never switch automatically.
- Adding scenarios appends to QR scenario indices; every dial, footer, pointer and
  keyboard step derives its count rather than assuming eight presets.
- Native minimize/hide keeps the radio alive in the menu bar. Quit is explicit.

When delivering, identify the visible change and checks performed, and rebuild
the DMG if the owner is testing the installed app. Follow `lvx-implementation` for
runtime or packaging changes accompanying the visual work.
