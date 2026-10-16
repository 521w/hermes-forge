# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-11
- Context: Discovered by Agent while building and verifying the Hermes Forge Android release APK
- Category: Build Methods | Testing Methods
- Instructions:
  - Release APK build: `cd web/android && export ANDROID_HOME=/opt/android-sdk && export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 && ./gradlew assembleRelease --no-daemon`; output at `android/app/build/outputs/apk/release/app-release.apk`. Signing keystore is `android/keystore/hermes-forge.keystore` (alias hermesforge), release signing configured in `app/build.gradle` `signingConfigs.release`.
  - APK download: served by the backend at `/download/hermes-forge-v1.0.apk` from `server/downloads/` (NOT `web/dist/` — `vite build` empties dist, so keep the APK in server/downloads and copy the built app-release.apk there). After any `vite build` + `cap sync android`, rebuild the APK and re-copy it.
  - Server tool + agent verification: run `npm test` in `server/` (`node --test test/*.test.mjs`). For end-to-end SSE/crew checks, point the backend at the mock LLM via `server/data/settings.json` (baseUrl `http://127.0.0.1:3999`), then restore the backup; the mock serves at `/chat/completions`.
  - Test layout rule (learned the hard way): `node --test` with no arguments collects **every** `.mjs` under `server/test/`, so a long-running server file placed there is executed as a test and hangs the runner — CI's `npm test` cancelled the whole job after GitHub's 6-hour limit because of exactly this. Server-like helpers belong in `server/mocks/`, which the runner does not collect. The mock is at `server/mocks/mock-llm.mjs` and exports `server` so tests can `listen(0)` on an ephemeral port; run it standalone with `npm run mock`.
  - `server/mocks/mock-llm.mjs` routing: a request body containing a `tools` array gets the tool-call branch; without `tools` it returns planner text. Only `/chat/completions` is served (no `/v1` prefix); every other path is a 404.
  - Crew Plan Mode: the planner's text plan is parsed into structured todos; tool progress is streamed as SSE `phase` events with `todos` (task texts) and `todoState` (pending/running/done). Both the server (`agents.js`) and the Android client (`localClient.ts`) implement this identically — keep them in sync.
  - Mock LLM endpoint serves OpenAI-compatible completions at `http://127.0.0.1:3999/chat/completions` (NO `/v1` prefix). Test requests to it must use that exact path.
  - `server/src/index.js` `buildClient()` calls `loadSettings()` on every request, so editing `server/data/settings.json` takes effect immediately without restart — used to point the backend at the mock LLM for SSE/crew verification, then restore the backup.
  - Android adaptive icon (API 26+): background must be a solid/gradient drawable and foreground must be a transparent-center glyph inside the 66dp safe zone; reusing the full launcher PNG as foreground gets double-cropped. Gradle `signingConfigs` block must be declared before `buildTypes`.
