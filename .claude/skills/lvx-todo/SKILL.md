---
name: lvx-todo
description: Use when the owner says to note, remind, add, tick, reorder or review something in todo.md ("segnati", "aggiungi al todo", "reminder", "cosa c'è da fare"), or shares an idea for later work without asking to implement it now.
---

# LVX todo

`todo.md` (project root, git-ignored) is the owner's private reminder list. It is written in Italian (a few sections in English) and the owner also edits it by hand.

**Scope: write reminders only.** Do not brainstorm, design or implement the item, even when it is tempting. Another session implements it later.

## Workflow

1. Read `todo.md` in full first: it changes between sessions (the owner or Codex may have edited it).
2. Check whether the idea already exists (even ticked). If so, update that item instead of duplicating it.
3. Add or change the item, then show the owner the diff in one or two lines.
4. Ask a question only if the wording is blocked; otherwise write it and flag doubts inside the item as `**Da chiedere.**`.

## Writing an item

- Checklist line: `- [ ] **Short bold title.**` then indented sub-bullets with what, why, and constraints.
- Put it under the fitting `##` section; create a new section only if none fits.
- Italian by default; keep the language of the section if it is English.
- Add facts found in the code (file paths such as `src/radio/station.js`, existing rules from `CLAUDE.md`) so the implementing session needs no rediscovery. Verify a path exists before citing it.
- Mention required order or checks (e.g. "prima in HTML con stub, poi DMG", "verificare con test fake engine").
- Big product ideas that are not a task yet: add under their own section marked "(idea, da investigare)"; `docs/backlog.md` if the owner asks.

## Changing state

| Request | Action |
|---|---|
| Done and verified | `[ ]` → `[x]`; tick only after implementation is verified, never on a guess |
| On hold | keep `[ ]`, add `**IN SOSPESO (date):** reason` |
| Dropped | delete the item only on the owner's explicit word |
| Review / "cosa resta?" | list only the open `[ ]` items grouped by section; do not start any |

Never rewrite, reorder or translate items the owner did not mention. Never commit `todo.md` (ignored by git).

## Mistakes

- Starting to implement or brainstorm the item (the owner interrupted this once).
- Duplicating an existing item instead of editing it.
- Ticking `[x]` because code was written but not verified.
- Vague items ("migliorare la UI") with no files or constraints.
