# Maskin iOS App — Tech Direction

**Status:** Proposed — pending milestone-0 spike
**Decision:** Tauri 2 iOS app in this monorepo (`apps/mobile`), wrapping `apps/web`
**Date:** 2026-08-11

## Summary & recommendation

Build the Maskin iOS app as a **Tauri 2 shell around the existing web frontend**, living in **this monorepo as `apps/mobile`** rather than a new repository. Validate the call with a short spike (milestone 0, below) on a real device before investing further.

The rationale, in order of weight:

1. **The mobile UI already exists.** Frontend responsiveness is a non-negotiable ship gate in this repo — every surface must work at 375px (see `apps/web/CLAUDE.md`). A wrapper ships that UI as-is; a native app rebuilds it screen by screen.
2. **Feature parity is automatic in-monorepo.** The Tauri shell consumes `apps/web`'s Vite build through Turborepo and shares `packages/shared` schemas. Every merge to main updates the mobile app's UI for free. A native Swift app must track the web app's feature velocity by hand, forever — permanent double-maintenance, not a one-time port.
3. **The hardest client code is already written** — and it is exactly the part no codegen can produce. SSE with custom auth headers, the Claude Code stream-JSON log parser, and the SSE→cache-invalidation map (details under [Integration surface](#integration-surface-what-any-ios-client-consumes)) all live in `apps/web` today, battle-tested.
4. **The org has done this before.** Skjald is built on Tauri and ships cross-platform (iOS, Android, macOS, Windows) with >90% cross-device code; the remainder is the Swift layer iOS requires. That experience transfers directly.
5. **The native must-haves are needed under either stack** — APNs push, Keychain storage, universal links. Under Tauri they are a thin plugin/Swift-shim layer (the ~10%); they are not a reason to rewrite the 90%.

## The head-to-head: Tauri vs native Swift

| Criterion | Tauri 2 (wrap `apps/web`) | Native Swift/SwiftUI |
|---|---|---|
| Time to TestFlight | Weeks — shell + native shims around an existing UI | Months — every screen and client subsystem from scratch |
| Ongoing maintenance | Near-zero UI drift; parity on every merge | Permanent second frontend tracking web velocity |
| Code reuse | >90% (Skjald precedent) | ~0% UI; partial API models via OpenAPI codegen |
| UX quality on device | Good if WKWebView behaves (spike gate); not pixel-native | Best-in-class platform feel |
| Push & background | Native either way — thin Tauri plugin + APNs | First-class |
| App Store risk | Guideline 4.2 (minimum functionality) scrutiny of webview apps — mitigated by push, deep links, native touches | None |
| Team skills | React/TS (existing) + small Rust/Swift surface | Full Swift/SwiftUI competency required |
| Real-time layer | Reused as-is | Hand-written (SSE endpoints absent from OpenAPI spec) |

### What Tauri buys

Maskin's hardest client logic already exists in `apps/web` and comes along for free:

- **SSE with custom headers** — `apps/web/src/lib/sse.ts` uses `@microsoft/fetch-event-source` precisely because the streams require `Authorization`, `X-Workspace-Id`, and `Last-Event-ID` headers that native `EventSource` cannot send.
- **Claude Code stream-JSON parsing** — `apps/web/src/lib/chat-stream.ts` documents and implements the envelope contract (`system`/`assistant`/`user`/`result`/`error`, content blocks `text`/`tool_use`/`thinking`) for session log rendering.
- **SSE→cache invalidation** — `apps/web/src/lib/sse-invalidation.ts` is the de-facto spec of which event action invalidates which resource.
- **iOS-Safari-hardened UX** — `apps/web/src/hooks/use-mobile.tsx` (44px touch targets per iOS HIG), `visualViewport` keyboard handling in the composer, swipe gestures in `use-swipe-to-mark-read.ts`.

### What Tauri risks

- Tauri 2's mobile support is younger than its desktop side; plugin coverage for iOS is thinner.
- WKWebView quirks — keyboard avoidance, scroll physics, gesture conflicts — can make a wrapper feel non-native. This is the main subjective gate the spike must clear.
- App Store guideline 4.2: webview-heavy apps get minimum-functionality scrutiny. Mitigations: push notifications, universal links, Keychain auth, and any native surface (share sheet, widgets later). Skjald shipping through review is the strongest evidence this is manageable.
- The ~10% native layer still requires Swift skills on the team — a smaller ask than a full native app, but not zero.

### What native Swift buys — and costs

Native buys best-in-class feel, a first-class background/push/widgets/App Intents story, no webview review risk, and independence from the web app's responsive behavior.

It costs a hand-written client layer. OpenAPI codegen only partially helps: the spec (`GET /api/openapi.json`, offline via `buildOpenAPIDocument()` in `apps/dev/src/openapi.ts`) covers ~150 routes, but:

- **Both SSE endpoints are absent** — the entire real-time surface, the point of a mobile companion app, is invisible to codegen and must be written by hand in Swift (URLSession bytes-streaming; `EventSource` can't send the required headers).
- **No security scheme is declared** — generated clients won't wire the `Authorization` header automatically.
- **Casing is inconsistent** — responses are camelCase (`workspaceId`, `createdAt`) while request bodies and SSE payloads are snake_case (`entity_id`, `workspace_id`); a single Swift `CodingKeys` strategy won't cover both.
- JSONB fields degrade to loose dictionaries, not typed models.

On top of the client layer, every UI surface gets rebuilt and must then track the web app's feature velocity forever.

### Options dismissed

- **Capacitor** — the conventional "wrap a Vite app" tool, with a mature iOS plugin ecosystem. Not chosen because the Skjald precedent gives the org working Tauri knowledge. It becomes relevant only if the spike fails on Tauri-specific tooling rather than on the webview concept itself.
- **React Native / Expo** — reuses React skills but not the DOM-based component tree; `apps/web`'s UI would be rewritten anyway, without gaining native's benefits. Worst of both paths.

## Integration surface (what any iOS client consumes)

Facts about the API contract, relevant regardless of stack:

### Auth

- Credential: `Authorization: Bearer ank_...` — a long-lived, plaintext API key (`packages/auth/src/api-keys.ts`). No expiry, no refresh tokens, no scopes.
- Workspace scoping: `X-Workspace-Id` header; `authMiddleware` enforces membership (404 on non-member).
- Signup `POST /api/actors` (mints the key; `auto_create_workspace` supported), login `POST /api/auth/login`, rotation `POST /api/actors/:id/api-keys`.
- Magic-link handoff (`apps/web/src/lib/magic-link.ts`) passes `#key=ank_...&actor_id=...` in a URL fragment — maps cleanly onto universal links for mobile sign-in.
- Structured errors: `{ error: { code, message, details[], suggestion } }` (`apps/web/src/lib/api.ts`).

### Real-time (SSE)

- **Workspace event bus** — `GET /api/events` (`apps/dev/src/routes/events.ts`): requires `X-Workspace-Id`; `Last-Event-ID` replays missed events (capped at 100 rows) then streams live via the PG NOTIFY bridge. **No heartbeat bytes are sent on the wire** — the 30s keep-alive loop emits nothing, so the client owns idle-timeout/reconnect policy.
- **Session log stream** — `GET /api/sessions/:id/logs/stream` (`apps/dev/src/routes/sessions.ts`): replays missed logs (capped at 500), streams `stdout`/`stderr`/`system` events, emits `done` on terminal sessions. Paginated fallback: `GET /api/sessions/:id/logs`.
- Both endpoints require custom headers → `@microsoft/fetch-event-source` on web, `URLSession` streaming if ever native.
- `Last-Event-ID` is persisted per-workspace (web: `sessionStorage` under `maskin-last-event-id-<workspaceId>`) — the mobile app reuses this for foreground-resume.

### Misc

- File upload: base64 → `POST /api/files` → `fileId` (established by the chat image-upload path).
- Analytics: PostHog already has a `platform_device: 'ios'` dimension the app should populate.
- The web app uses a relative `API_BASE = '/api'` behind the Vite proxy — the wrapper needs an env-driven absolute base URL (small `apps/web` change, see spike).

## Mobile-specific work (the ~10% that is native either way)

1. **Push notifications.** SSE dies when the app backgrounds — notifications require APNs. That means backend work too: a push service and a device-token registration endpoint. Out of scope for the spike; named here so it's planned, not discovered.
2. **Secure credential storage.** The `ank_` key is long-lived and plaintext; the web app keeps it in `localStorage`. An App Store app must store it in the iOS Keychain (Tauri stronghold/keychain plugin). Flag for backend follow-up: an app-store-distributed client raises the missing expiry/refresh story from "acceptable for a SPA" to a real design question.
3. **Universal links** for the magic-link auth handoff and shareable object URLs.
4. **App lifecycle**: reconnect SSE on foreground and resume with `Last-Event-ID`; suspend cleanly on background.
5. **Mobile UX deltas**: safe-area insets, no hover states (already largely handled by the 375px gate), keyboard avoidance inside WKWebView, offline banner behavior on flaky cellular.

## Milestone 0 — the spike

Goal: validate the recommendation on a real device before real investment. Scope: one to two weeks, one developer.

1. Scaffold a Tauri 2 iOS project as `apps/mobile`, pointing at `apps/web`'s Vite build. Add an env-driven absolute `API_BASE` to `apps/web` (it currently assumes the `/api` proxy).
2. Run on simulator and a physical iPhone.

**Pass criteria — all must hold:**

- Login and workspace switching work end-to-end.
- `GET /api/events` streams live inside WKWebView and resumes with `Last-Event-ID` after a background→foreground cycle.
- A session log stream renders correctly (stream-JSON chat view).
- API key is stored in the Keychain via a Tauri plugin, not web storage.
- Keyboard, safe-area, and scroll behavior feel acceptable on the physical device. This is the explicit **subjective gate** — "does it feel native enough" is a judgment call, and it is the criterion most likely to fail.

**Bail-out clause:** if a failure is webview-inherent (SSE, keyboard, or feel fundamentally broken in WKWebView), the answer is native Swift, and the head-to-head section above becomes the plan for that path. If the failure is Tauri-specific tooling, evaluate Capacitor before going native.

## Repo shape: `apps/mobile` in this monorepo

A separate repository was considered and rejected: the entire value of the wrapper is consuming `apps/web`'s build through Turborepo, sharing `packages/shared` schemas, and inheriting feature parity on every merge. A separate repo would reintroduce the drift problem the wrapper exists to avoid.

Costs to manage in-repo:

- **Toolchain isolation** — Xcode and the Rust toolchain must not become prerequisites for `pnpm dev`. The mobile build gets its own opt-in turbo task; contributors without macOS are unaffected.
- **CI** — deferred until after the spike; when added, the iOS build runs on a macOS runner as a separate, non-blocking job initially.
- **Release cadence** — App Store releases decouple from continuous web deploys via git tags; the shell can also point at the deployed web origin (remote-URL mode) if fully bundled releases prove too slow, a trade-off (offline behavior vs release speed) the spike should inform.

## See also

- `apps/web/CLAUDE.md` — responsive ship gate (375/768/1024px) and frontend conventions
- `apps/web/src/lib/sse.ts`, `chat-stream.ts`, `sse-invalidation.ts` — the client logic being reused
- `apps/dev/src/openapi.ts` — offline OpenAPI document builder (SDK-generation entry point, if ever needed)
- `.claude/rules/structural-verification.md` — file-placement rules that apply when `apps/mobile` is scaffolded
