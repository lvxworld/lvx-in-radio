# Repository Guidelines

## Project Structure & Module Organization

- `src/electron/`: the desktop app; the only place that imports Electron.
- `src/engine/`: audio.cpp process, model setup and WAV helpers.
- `src/radio/`: station scheduler and style prompt.
- `src/server/`: local HTTP API and static hosting.
- `src/ui/`: interface and its vendored assets.
- `tests/`: automated tests.

## Build, Test, and Development Commands

Node.js 24 or later. `npm start` runs the radio in a browser, `npm run app` runs the desktop app, `npm run dist` builds the DMG and `npm test` runs the unit tests. See `DEVELOPMENT.md` for configuration and releases.

## Coding Style & Naming Conventions

ES modules on Node.js 24, two-space indentation. Use descriptive names and consistent filename casing within each module, and prefer Node built-ins over new dependencies.

## Testing Guidelines

Use the existing `node:test` runner with fake engines and small HTTP fixtures. Use descriptive test names that identify the behavior and expected result. Add regression tests for bug fixes, and document how to run the suite and any required services.

## Commit & Pull Request Guidelines

Use concise, imperative commit subjects such as `Add station playback controls`. Keep commits focused on one change. Push only when the owner asks. Publish code changes through a pull request; never push directly to `main`. Create release tags from `main` only after the pull request has been merged.

Before building a DMG, always prepare and share a working HTML preview of the proposed interface changes with the owner.

Pull requests should explain the purpose, summarize behavior changes, link relevant issues, and report validation performed. Include screenshots for visible interface changes and identify any setup or configuration changes.

## Security & Configuration

Keep credentials in environment variables or ignored local configuration. Provide placeholder values in example configuration files and document required settings.

## Project skills

Before UI, typography, icon, animation or layout work, load
`.claude/skills/lvx-ui-design/SKILL.md`. Before radio, setup, Electron, persistence,
API or packaging changes, load `.claude/skills/lvx-implementation/SKILL.md`.
Use both for features spanning UI and behavior. They are discoverable by Codex in
`.agents/skills/` through repository-relative links and by Claude Code directly
in `.claude/skills/`. `todo.md`, when present, is the owner's private reminder list: it is not part of the repository.

## DJ writer runtime

`scripts/fetch-dj-llm.js` (`npm run fetch-dj-llm`, also run by `npm run dist`) puts llama.cpp's
`llama-server` and the libraries it loads into `vendor/dj-llm`, from one pinned release checked by
SHA-256, like `fetch-engine`. To update llama.cpp, change `VERSION` and `SHA256` there, run
`npm run fetch-dj-llm`, and check that the DJ still writes valid lines. The writer weights are one
pinned GGUF in `src/engine/dj-llm-manifest.json`.

## Bundled music

Append to the songs in `lux/` and keep existing entries and files unchanged: listeners' likes refer to their ids.
