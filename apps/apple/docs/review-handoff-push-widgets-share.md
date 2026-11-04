# Review hand-off: actionable push, widgets, share extension

Status lines added 2026-10-17 against `apple/native-to-main` (read-only code check, nothing built; server code is not on this base).

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
   **Status 2026-10-17:** FIXED. `ShareFixtures.swift:80-86` has `extension ShareItemSource where Self == ShareFakeSource` with the four factories, used as `[.link(...)]` in `ShareExtractorTests.swift:20`.
2. **The app never reloads the widgets.** `WidgetReloader` / `makeWidgetReloader()` have no caller.
   Call it on: `ForYouStore` fetch completion and `choose/reply/dismiss/undo`; `AuthSession` sign-in,
   sign-out and workspace switch; `scenePhase == .background`; the notification-action runner;
   push receipt. Without it, answered decisions linger and a signed-out widget keeps private titles.
   **Status 2026-10-17:** FIXED. Callers: `ForYouStore.swift` (`widgetReloader.reload()` after revalidate and on choose/reply/dismiss/undo etc.), `RootView.swift` (actor/workspace change, `scenePhase == .background`), `NotificationActionRunner.swift:63` (after a notification action), `BackgroundRefresh.swift:39`, `ForYouRuntime.swift:85`. Push receipt not separately verified.
3. **Widget timeline has no stale/expiry entries when fresh** (`WidgetPolicy.swift:56-62`). Always add
   `updatedAt+30min` (stale) and `updatedAt+12h` (expire) entries; raise `refreshInterval` to ~30 min.
   **Status 2026-10-17:** FIXED. `WidgetPolicy.plan` always appends the `staleAfter` and `expireAfter` entries; `refreshInterval` is 30 min. Tests in `WidgetTests.swift` ("a fresh load reloads in 30 minutes and still schedules stale and expiry entries").
4. **Possible Swift 6 compile error** in `Apps/MaskinNotificationService/NotificationService.swift:39-57`
   (non-Sendable `content` / `merged` captured in callbacks; `finish` can run twice). Guard with an
   `NSLock` or an `@unchecked Sendable` box, then build.
   **Status 2026-10-17:** CHANGED. `NotificationService.swift` now guards state with an `NSLock`, `finish` delivers once, `nonisolated(unsafe)` box for `content`. Not built with Xcode here, so Swift 6 compile status remains unverified.

## Push

5. **Truncated label is posted as the answer** (`apps/dev/src/services/apns.ts` `compactDecision`,
   `NotificationActionHandler.swift:80`). Server cuts labels to 40 chars + "…" and the client posts it
   verbatim. Send the option index and resolve the label server-side, or never post the "…".
   **Status 2026-10-17:** CLIENT FIXED; server side unverified here. `PushDecision.swift:13` documents that labels arrive whole and the server sends no actions for an over-long label; `PushDecisionTests` (long labels stay whole) covers the parse. `apps/dev/src/services/apns.ts` is not on this base: client side verified; server side unverified here.
6. DECISION: **no confirm step for irreversible options.** The decision schema has no `destructive`
   field (`packages/shared/src/schemas/comment-decision.ts`); the client reads `raw["destructive"]` but
   nothing sends it, so every option is one tap, including on the lock screen. Add the field, or route
   such options to the app via Open.
   **Status 2026-10-17:** FIXED client side; server side unverified here. `NotificationActionPlan.init` turns a `destructive` option into a "Review “label”" button of kind `.open` (never posts from the lock screen); the payload parser reads `destructive`. Tests: `anOptionThatNeedsConfirmationOpensTheCardInsteadOfSending` plus the Review/one-tap/mixed/never-posting tests added with this refresh. `packages/shared/src/schemas/comment-decision.ts` has no `destructive` field on this base and `apns.ts` is absent: client side verified; server side unverified here.
7. One overall ~20 s deadline for the action handler (`NotificationActionHandler.swift:65`): two
   sequential 20 s attempts can exceed the ~30 s background window.
   **Status 2026-10-17:** FIXED. `NotificationActionHandler.perform` computes one `deadline` shared by both attempts (comment, mark-read); see the doc comment on `attemptTimeout`.
8. Category registration race: `registerFallbackCategory()` (`NotificationActionRunner.swift:109-124`)
   replaces the whole set and can clobber the extension's category; the fallback only exists after the
   app has launched once.
   **Status 2026-10-17:** CHANGED, partly open. `registerFallbackCategory()` now merges with the existing set and skips the write when already registered, narrowing the race to the first launch; the fallback still only exists after the app has launched once.
9. Failure repost loses sound / Time Sensitive; `.queued`/`.answered` repost has no category.
   **Status 2026-10-17:** PARTLY OPEN. `NotificationActionRunner.present` copies `categoryIdentifier` (line 89) and uses `.passive`; sound / Time Sensitive on the failure repost is not restored (not found in code).
10. Backend: `recommended` is computed before blank labels are filtered (off by one if a label were
    blank; schema forbids it today). Options beyond 3 are dropped silently.
   **Status 2026-10-17:** Server code (`apps/dev`) not on this base: client side n/a; server side unverified here.
11. Tests missing: `NotificationService.category(for:)` + merge/prune, `NotificationActionRunner`,
    the time budget, a two-process Keychain read.
   **Status 2026-10-17:** OPEN for `NotificationService.category(for:)`/merge and `NotificationActionRunner` (no test references found under `Tests/`); time-budget and Keychain two-process tests not verified.

## Widgets

12. Tap target: `WidgetSnapshot.swift:74-83` links `DeepLink.object`. Confirm that lands on the
    answerable decision UI; the mockup opens the For you tab. Small/medium only link the top decision.
   **Status 2026-10-17:** UNVERIFIED (product confirmation; not re-checked in this pass).
13. Lock screen differs from the mockup (mockup: count + top two asks + "X suggests Y"). Snapshot
    already has `recommendedLabel` and `agentName`; use `.privacySensitive()` so locked devices redact.
   **Status 2026-10-17:** PARTLY FIXED. `LockScreenViews.swift` / `HomeWidgetViews.swift` mark content `.privacySensitive()`; layout parity with the mockup not re-checked.
14. Fetching the whole `/subscriptions/unread` feed to show 3 cards risks the ~30 MB widget limit.
    Prefer a small endpoint or `?limit=`.
   **Status 2026-10-17:** FIXED. `APIWidgetDataSource.swift:42` queries with `limit: WidgetSnapshot.unreadCap`.
15. Keychain: needs Keychain Sharing on App ID `io.maskin.app.widgets`; unsigned/simulator builds fall
    back to an ungrouped item and the widget silently shows "signed out". The widget read path can run
    `migrate()` (writes from the extension); consider read-only.
   **Status 2026-10-17:** OPEN / unverified. `SecretStore.swift` still has a `migrate(...)` path and a default shared access group; entitlement setup and a read-only widget path cannot be verified without a signed build.
16. iOS 18 tinted modes (`widgetAccentable` / `widgetRenderingMode`), fixed 118 pt column in medium,
    no `ViewThatFits` at accessibility sizes. Lock-screen and home widgets are separate kinds, so each
    spends its own reload budget.
   **Status 2026-10-17:** PARTLY FIXED. `widgetAccentable`, `widgetRenderingMode` and accessibility-size handling (`typeSize.isAccessibilitySize`) exist in `HomeWidgetViews.swift`; `ViewThatFits` and the fixed medium column not re-checked.

## Share extension

17. No background upload continuation (`ShareRemote.swift:82-104`); swipe-dismiss mid-upload loses the
    share. Create the object first and show "Sent", then upload files; or document the limit.
   **Status 2026-10-17:** CHANGED. `ShareQueue.swift` parks a failed share (`PendingShare`) for the app to finish; mid-upload swipe-dismiss behaviour not verified.
18. User text lost: title/note only in memory, no confirm on dismiss with a note, and the `.blocked`
    screen replaces the form so the text cannot be copied. Offer Copy, or persist a draft.
   **Status 2026-10-17:** PARTLY FIXED. `ShareDraftStore.swift` persists title and note per content fingerprint; a Copy affordance on the blocked screen not verified.
19. Cleanup only runs through `close()`/`.posted`; add `viewDidDisappear` cleanup and sweep stale
    `maskin-share-*` dirs. Cancel should call `cancelRequest(withError:)`, not `completeRequest`.
   **Status 2026-10-17:** PARTLY FIXED. `ShareViewController.swift:48` has `viewDidDisappear` and `:68` uses `cancelRequest(withError:)`; `ShareExtractor.swift:31` sweeps stale `maskin-share-*` directories.
20. Activation caps of 5 hide Maskin from the sheet entirely at 6 items; `WebURLWithMaxCount=1` blocks
    2 links. Raise the activation counts (e.g. 10) and keep the in-code limit of 5 with the skip note.
   **Status 2026-10-17:** CHANGED. `project.yml` sets images/files max 10; `WebURLWithMaxCount` is 2, so two links work but three do not.
21. `ShareSheetModel.swift:96` sets `.ready` before the workspace schema loads; fallback status `"new"`
    can be rejected. Disable Send until it loads. No request timeouts; Cancel disabled while posting.
   **Status 2026-10-17:** PARTLY FIXED. `canPost` is false while `isLoadingSchema`; request timeouts set in `ShareSession.swift:34` (20 s request, 120 s resource); `cancelPosting()` exists.
22. Skipped oversize file: reason lost when it was the only item (`.blocked(.nothingToShare)`).
   **Status 2026-10-17:** UNVERIFIED. Skip reasons exist in `ShareExtractor` (`.overLimit`, `.truncatedText`); the only-item case was not re-checked.
23. DECISION: the mockup's chat destination is not implemented (`ShareDestination` is `.object` /
    `.filesOnly` only); also no Loop/agent picker or "FROM MAIL" source label.
   **Status 2026-10-17:** CHANGED. `ShareDestination` now has `.chat(id:)`; Loop/agent picker and "FROM MAIL" label not verified.
24. Minor: Safari image share drops the page link; text silently cut at 20,000 chars;
    `createdObjectBeforeFailure()` unused in the view; no VoiceOver announcement on post/fail;
    verify `maskin://open` is handled by the app router.
   **Status 2026-10-17:** PARTLY FIXED. Text cut is now reported via `.truncatedText`; VoiceOver announcements added (`ShareSheetView.swift:53-59`); `createdObjectBeforeFailure` is used in `ShareSheetView.swift:140`. Safari image page link and `maskin://open` routing not re-checked.

## Live Activity / Dynamic Island (originally "Not built")

**Status 2026-10-17: BUILT.** `Apps/MaskinLiveActivity/` has `CycleLiveActivity`, `MeetingLiveActivity` and `AgentsLiveActivity` (`ActivityConfiguration`), `Sources/MaskinCore/LiveActivity/` holds the controllers and `APILiveActivityTokens.swift`, and `project.yml` sets `NSSupportsLiveActivities`. Client side verified; the server-side `liveactivity` push is unverified here. The original suggestion below is kept for history.

Original note:

No ActivityKit anywhere. Suggested minimum, after items 1-3:
- `SessionActivityAttributes` in `Sources/MaskinCore/Widget/` behind `#if canImport(ActivityKit)`;
  static: sessionId, workspaceId, agentName, taskTitle, startedAt; state: phase
  (starting/running/needsYou/paused/done/failed), step (<= 40 chars), decisionObjectId.
- `ActivityConfiguration` added to the existing `MaskinWidgetBundle` (no new target);
  `NSSupportsLiveActivities` in the main app's Info properties; no new entitlements.
- Local start from "run agent"; updates need an APNs `liveactivity` push (new token table, throttle
  ~1 per 30-60 s, priority 10 for needsYou/terminal) plus an integration test per
  `.claude/rules/verification.md`. Ship local-start first, server push second.

## Status 2026-10-29 (branch `apple-push-widget-share-gaps`)

- **8** The service extension now also inserts the fixed fallback category (`PushCategories.merged`), so it exists before the app ever launches. Also fixed: the merge removed the replaced category with `Set.remove`, which does not match by identifier, so a rebuilt category with the same identifier was kept twice; it now matches by identifier. Tests: `PushCategoriesTests`.
- **9** A failed repost keeps the original's buttons, sound and Time Sensitive level (`NotificationRepost`). Answered / queued / deferred reposts deliberately carry no buttons (answering twice must not be one tap away); documented and tested.
- **11** Tests added: `PushCategoriesTests`, `NotificationRepostTests`. The shared time budget was already covered by `bothWritesShareOneDeadline`. A two-process Keychain read still needs a signed device.
- **15** `KeychainSecretStore(readOnly: true)` is used by the widget read paths: no `migrate()` from the extension. Still required (signing is out of scope here): Keychain Sharing on App ID `io.maskin.app.widgets` with the same first group as the app; without it the widget shows "signed out".
- **18** The blocked screen already offers "Copy your text" (`copyableText`).
- **20** `NSExtensionActivationSupportsWebURLWithMaxCount` raised from 2 to 10; extra links are kept in the text.
- **22** Already fixed: `blockedDetail` shows the skip reason (`ShareHardeningTests`).
- **24** `maskin://open` parsed as the inbox of a workspace called "open" and ended in a not-a-member rejection; `DeepLinkRouter.isOpenApp` now accepts it as a plain foreground. Safari image share: the extractor keeps the page link in every item order tested; whether Safari delivers the address in a separate provider needs a device.
- **13** Lock-screen layout parity with the mockup is not done (design work).
