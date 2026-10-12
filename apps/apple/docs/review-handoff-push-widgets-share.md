# Review hand-off: actionable push, widgets, share extension

Static read-only review of the uncommitted work on `apple/native-app-foundation` (2026-10-03).
Nothing was built or run. Every Swift 6 claim is unverified until a build confirms it.
Commit `2a1d1531e` (For you / Chats simplification) is separate and does not touch these files.

Ranked by value. Items marked DECISION need a product call before code.

## Do first

1. **Share tests do not compile.** `Tests/MaskinCoreTests/Share/ShareFixtures.swift:66-77` declares
   `link/text/image/pdf` as statics on `ShareFakeSource`, but the tests call `[.link(...)]` against
   `[any ShareItemSource]`. Move the four factories into
   `extension ShareItemSource where Self == ShareFakeSource { ... }`. No call-site changes; do not add
   statics to the production protocol.
2. **The app never reloads the widgets.** `WidgetReloader` / `makeWidgetReloader()` have no caller.
   Call it on: `ForYouStore` fetch completion and `choose/reply/dismiss/undo`; `AuthSession` sign-in,
   sign-out and workspace switch; `scenePhase == .background`; the notification-action runner;
   push receipt. Without it, answered decisions linger and a signed-out widget keeps private titles.
3. **Widget timeline has no stale/expiry entries when fresh** (`WidgetPolicy.swift:56-62`). Always add
   `updatedAt+30min` (stale) and `updatedAt+12h` (expire) entries; raise `refreshInterval` to ~30 min.
4. **Possible Swift 6 compile error** in `Apps/MaskinNotificationService/NotificationService.swift:39-57`
   (non-Sendable `content` / `merged` captured in callbacks; `finish` can run twice). Guard with an
   `NSLock` or an `@unchecked Sendable` box, then build.

## Push

5. **Truncated label is posted as the answer** (`apps/dev/src/services/apns.ts` `compactDecision`,
   `NotificationActionHandler.swift:80`). Server cuts labels to 40 chars + "…" and the client posts it
   verbatim. Send the option index and resolve the label server-side, or never post the "…".
6. DECISION: **no confirm step for irreversible options.** The decision schema has no `destructive`
   field (`packages/shared/src/schemas/comment-decision.ts`); the client reads `raw["destructive"]` but
   nothing sends it, so every option is one tap, including on the lock screen. Add the field, or route
   such options to the app via Open.
7. One overall ~20 s deadline for the action handler (`NotificationActionHandler.swift:65`): two
   sequential 20 s attempts can exceed the ~30 s background window.
8. Category registration race: `registerFallbackCategory()` (`NotificationActionRunner.swift:109-124`)
   replaces the whole set and can clobber the extension's category; the fallback only exists after the
   app has launched once.
9. Failure repost loses sound / Time Sensitive; `.queued`/`.answered` repost has no category.
10. Backend: `recommended` is computed before blank labels are filtered (off by one if a label were
    blank; schema forbids it today). Options beyond 3 are dropped silently.
11. Tests missing: `NotificationService.category(for:)` + merge/prune, `NotificationActionRunner`,
    the time budget, a two-process Keychain read.

## Widgets

12. Tap target: `WidgetSnapshot.swift:74-83` links `DeepLink.object`. Confirm that lands on the
    answerable decision UI; the mockup opens the For you tab. Small/medium only link the top decision.
13. Lock screen differs from the mockup (mockup: count + top two asks + "X suggests Y"). Snapshot
    already has `recommendedLabel` and `agentName`; use `.privacySensitive()` so locked devices redact.
14. Fetching the whole `/subscriptions/unread` feed to show 3 cards risks the ~30 MB widget limit.
    Prefer a small endpoint or `?limit=`.
15. Keychain: needs Keychain Sharing on App ID `io.maskin.app.widgets`; unsigned/simulator builds fall
    back to an ungrouped item and the widget silently shows "signed out". The widget read path can run
    `migrate()` (writes from the extension); consider read-only.
16. iOS 18 tinted modes (`widgetAccentable` / `widgetRenderingMode`), fixed 118 pt column in medium,
    no `ViewThatFits` at accessibility sizes. Lock-screen and home widgets are separate kinds, so each
    spends its own reload budget.

## Share extension

17. No background upload continuation (`ShareRemote.swift:82-104`); swipe-dismiss mid-upload loses the
    share. Create the object first and show "Sent", then upload files; or document the limit.
18. User text lost: title/note only in memory, no confirm on dismiss with a note, and the `.blocked`
    screen replaces the form so the text cannot be copied. Offer Copy, or persist a draft.
19. Cleanup only runs through `close()`/`.posted`; add `viewDidDisappear` cleanup and sweep stale
    `maskin-share-*` dirs. Cancel should call `cancelRequest(withError:)`, not `completeRequest`.
20. Activation caps of 5 hide Maskin from the sheet entirely at 6 items; `WebURLWithMaxCount=1` blocks
    2 links. Raise the activation counts (e.g. 10) and keep the in-code limit of 5 with the skip note.
21. `ShareSheetModel.swift:96` sets `.ready` before the workspace schema loads; fallback status `"new"`
    can be rejected. Disable Send until it loads. No request timeouts; Cancel disabled while posting.
22. Skipped oversize file: reason lost when it was the only item (`.blocked(.nothingToShare)`).
23. DECISION: the mockup's chat destination is not implemented (`ShareDestination` is `.object` /
    `.filesOnly` only); also no Loop/agent picker or "FROM MAIL" source label.
24. Minor: Safari image share drops the page link; text silently cut at 20,000 chars;
    `createdObjectBeforeFailure()` unused in the view; no VoiceOver announcement on post/fail;
    verify `maskin://open` is handled by the app router.

## Not built: Live Activity / Dynamic Island

No ActivityKit anywhere. Suggested minimum, after items 1-3:
- `SessionActivityAttributes` in `Sources/MaskinCore/Widget/` behind `#if canImport(ActivityKit)`;
  static: sessionId, workspaceId, agentName, taskTitle, startedAt; state: phase
  (starting/running/needsYou/paused/done/failed), step (<= 40 chars), decisionObjectId.
- `ActivityConfiguration` added to the existing `MaskinWidgetBundle` (no new target);
  `NSSupportsLiveActivities` in the main app's Info properties; no new entitlements.
- Local start from "run agent"; updates need an APNs `liveactivity` push (new token table, throttle
  ~1 per 30-60 s, priority 10 for needsYou/terminal) plus an integration test per
  `.claude/rules/verification.md`. Ship local-start first, server push second.
