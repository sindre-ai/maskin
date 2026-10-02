# apps/apple — native Maskin clients (SwiftUI)

One Swift package (`MaskinKit`) + thin app targets. Read `/Users/krumhausen/.claude/plans/let-s-build-an-ios-zippy-puffin.md` for the architecture and `.claude/rules/*` at the repo root for repo-wide rules.

## Layers (dependencies point down only)
`Apps/*` → `MaskinFeatures` → `MaskinCore`, `MaskinUI` → `MaskinAPI`, `MaskinDesign`
- `MaskinDesign` — tokens. `Generated/Tokens.swift` is GENERATED (`node scripts/gen-tokens.mjs`); never hand-edit. Hand-written iOS additions live beside it, not in it.
- `MaskinAPI` — generated OpenAPI client (`openapi.json`, regenerate via `pnpm --filter @maskin/dev exec tsx scripts/dump-openapi.ts`), `SSEClient`, `MaskinClient`. Generated operation names are ugly (`get_sol_api_sol_objects`); NEVER leak them above a store's private adapter.
- `MaskinCore` — `@MainActor @Observable` stores, models, outbox, caches. No SwiftUI/UIKit imports (watch, tv, mac share it).
- `MaskinUI` — stateless SwiftUI components taking plain values.
- `MaskinFeatures` — screens. Adaptive (size classes / `NavigationSplitView`), never per-device forks. Platform differences only via `#if os()` in small files.

## Rules
- Swift 6 language mode, strict concurrency. Tabs for indentation. Swift Testing (`import Testing`), not XCTest.
- Every colour/radius/spacing/duration comes from `MaskinColor`/`MaskinRadius`/`MaskinSpace`/`MaskinDuration`. No literals. Light + dark both work (`Color(light:dark:)`).
- Native first: use system SwiftUI (iOS 26 glass, `TabView`, `NavigationStack`, `.searchable`, sheets) instead of recreating the mockup's web chrome. The mockup is directional, not pixel spec.
- Stores take their network dependency as a protocol (see `Authenticating`/`AuthSession`) so they test without a server. Every store has tests; every non-trivial view model logic has tests.
- Writes carry an `Idempotency-Key`. Mutations are optimistic with rollback on failure.
- Provider/internal ids never render as labels (live-verification rule): show a resolved name.
- Verify by running, not by reading: `swift test` must pass; UI work must be built for an iOS simulator.

## Building without stepping on other agents (shared worktree!)
Several agents work in this tree at once. ALWAYS use a private scratch path:
`swift build --scratch-path $SCRATCH/<yourname>` / `swift test --scratch-path $SCRATCH/<yourname>` and
`xcodebuild ... -derivedDataPath $SCRATCH/<yourname>-dd`, where `$SCRATCH` is the session scratchpad dir given in your brief.
Only edit files you own (listed in your brief). Never edit `Package.swift`, `openapi.json`, `Generated/`, or another agent's files — message the lead (SendMessage to `lead`) if you need a change there. No `git stash`, no commits, no `git checkout`.
