---
name: lvx-implementation
description: Implement or improve LVX in Radio's code without breaking its radio, resource or persistence rules. Use for scheduler, audio.cpp, model setup, API/SSE, presets, Lux codes, Electron lifecycle/tray, packaging, tests or refactoring in this repository.
---

# LVX implementation

Read `AGENTS.md`, the private `todo.md` if present, and the relevant architecture section of `CLAUDE.md`.
Use the existing module boundaries and Node built-ins. Preserve user data and
scope implementation to the requested behavior; the user's explicit decisions
supersede earlier notes.

## Domain rules

- One engine job at a time. Moving stations lets a started song finish and store
  on its originating station; that abandoned station starts nothing further.
  Only explicit Stop on the owning station, the job's X or quitting aborts it.
- A new-station preparation waits for a running job, then precedes ordinary due
  work. Generate now skips the due-time delay, not the single-job constraint.
  After completion, recalculate the runway from the music actually available.
- Playback keeps going while composing and setup runs. A completed station is an
  invitation, never an automatic retune. Pausing starts no scheduled work; explicit
  Generate now is intentional. An idle model unloads to free memory.
- Bundled LVX stations use their own MP3 catalog, reserved frequencies and feedback;
  they never start the engine. User-station songs stay until the user rejects them.
- English sung Direct requests retain existing behavior unless a change is asked
  for. `[instrumental]` alone does not remove vocals: true instrumental mode plans
  and rests the vocal line before rendering. Keep modes separate in library replay
  and in QR settings; share the first song's seed, not a fresh resume seed.
- Setup verifies pinned lengths/hashes before enabling generation. Downloads pause,
  resume and recover across restart. External model folders are used in place.
  Never include weights in the DMG or depend on a sibling checkout in the build.

## Architecture and compatibility

Use `src/start.js` to compose modules, `src/radio/` for radio state,
`src/engine/` for engine/setup lifecycle, and `src/server/` for loopback APIs.
Electron imports stay in `src/electron/`; sandboxed preload exposes small validated
operations. The server/SSE owns generation state; UI owns presentation and playback
reporting. A native hide is not a quit: the tray keeps audio and engine work alive.

Keep ids, serialized field meanings and persisted paths stable. Append scenario
indices in `lvx-code.js`; changing their order corrupts existing shared codes.
Q8_0 plus F16 VAE remains the quality baseline. Data from the first preview remains
in `Application Support/LVX Radio` despite the display name **LVX in Radio**.

## Implementation and evidence

1. Trace the failing or requested behavior through its public entry point and
   identify the owning module. For a bug, produce a concrete reproduction.
2. Add regression tests for lifecycle, concurrency, serialization, downloads and
   scheduler changes. Use fake engines and small HTTP fixtures; ordinary tests
   must run without model weights, Electron, a vendor binary or the sibling repo.
3. Patch the owner of the behavior; avoid parallel sources of truth. Handle error,
   cancellation, restart and ready states as part of the feature.
4. Run the relevant checks, then `npm test` when behavior crosses modules. Check
   Node 24 from README if the system Node is broken. Use the graphics skill for
   any visible changes and inspect browser console errors.
5. For native changes, test the packaged app with a temporary `LVX_DATA_DIR`,
   playback continuing while hidden, restoration, and explicit quit stopping its
   engine. `npm run fresh` exercises the DMG without touching ordinary data.
6. Build `npm run dist` for installed-app changes. It removes old distributions
   only after a new build succeeds. Report the current DMG, what was actually
   tested and what remains unverified. Avoid unnecessary GPU generations.

Push and release only when the owner asks.
Tick `todo.md` entries individually after their behavior has been verified.
Use focused commits and document changed behavior rather than promising tests
that were not performed.
