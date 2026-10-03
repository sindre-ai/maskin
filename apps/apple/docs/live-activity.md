# Live Activity for a running agent turn

Lock Screen + Dynamic Island card showing the current step, an elapsed timer, a Stop button, and a
"Needs you" state that opens the thread. **Needs real-device verification**: the simulator renders
the UI but does not deliver Live Activity pushes, and ActivityKit token callbacks only fire on
hardware.

## Pieces

| Piece | Where |
|-------|-------|
| State + attributes (`TurnActivityState`, `MaskinTurnAttributes`) | `Sources/MaskinCore/LiveActivity/TurnActivityState.swift` |
| Foreground start/update/end + token registration logic | `Sources/MaskinCore/LiveActivity/TurnActivityCoordinator.swift` |
| `POST/DELETE /api/live-activities/tokens` client | `Sources/MaskinCore/LiveActivity/APILiveActivityTokens.swift` |
| Stop (background API call) | `Sources/MaskinCore/LiveActivity/TurnStopper.swift`, `Apps/LiveActivityShared/StopTurnIntent.swift` |
| ActivityKit host (iOS app) | `Apps/Maskin/TurnActivityHost.swift`, wired in `MaskinApp.swift` |
| UI extension target `MaskinLiveActivity` | `Apps/MaskinLiveActivity/`, `project.yml` |

The JSON of `TurnActivityState` and the attributes type name `MaskinTurnAttributes` are a contract
with the backend's APNs sender. `startedAt` uses Swift's default `Date` coding (seconds since
2001); never put a date strategy on a coder that touches it.

## Manual steps (cannot be done from code)

1. **Info.plist**: `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates` are
   set on the app in `project.yml`. Confirm both appear in the built app's Info.plist.
   `FrequentUpdates` is needed because the backend pushes a step-text update at most every 5 s
   per session (`LIVE_ACTIVITY_THROTTLE_MS` in `apps/dev/src/services/live-activity-push.ts`),
   at APNs priority 5. Without the key iOS applies its default update budget to those
   low-priority pushes and drops them on a long turn, so the card would freeze mid-turn. The
   user can still turn it off per app in Settings; start/end pushes are priority 10 and are
   unaffected.
2. **App ID for `io.maskin.app.liveactivity`**: register it in the developer portal (new
   extension bundle id). It needs no special capability; it is a WidgetKit extension.
3. **Push Notifications capability on `io.maskin.app`** (already needed for APNs). Live Activity
   pushes use the same key as normal pushes; the backend sends to topic
   `io.maskin.app.push-type.liveactivity`.
4. Regenerate the project (`xcodegen generate`) and set `DEVELOPMENT_TEAM` in
   `Config/Local.xcconfig`.
5. On a device: Settings > Maskin > Live Activities must be on. iOS 17.2+ is needed for
   push-to-start; on 17.0/17.1 only the foreground fallback and update/end pushes work (the
   activity must have been started by the app).
6. `openapi.json` does not yet contain `/api/live-activities/tokens`; `APILiveActivityTokens`
   uses `URLSession` until the snapshot is regenerated.

## Device checklist

- Send a message that starts an agent turn with the thread open: a card appears (foreground
  fallback), the timer ticks, the step text changes.
- Background the app / lock the phone: the backend's pushes update and end the card.
- Kill the app, start a turn from the web: the push-to-start token starts the card.
- Stop on the Lock Screen: the turn stops, the card shows "Stopped" and goes away.
- A turn that needs you shows the amber state; tapping opens the thread (`maskin://<ws>/chats/<id>`).
- Confirm tokens landed: rows in the backend's live-activity tokens table for this device.

## Sign-out and the Stop button

- On sign-out (or a rejected key) `TurnActivityCoordinator.signedOut` ends every card at once and
  `DELETE`s every registered update token, using the ending session's credentials (the live
  session is already cleared by the time the requests go out). The push-to-start token belongs to
  the device and is re-registered under the next account.
- `TurnStopper` refuses when the Keychain session's workspace differs from the card's, so a
  card left over from another workspace can never stop a turn as the wrong identity. The
  attributes do not carry an actor id (that would change the backend contract); the sign-out
  teardown above is what covers an account switch.
- The extension target links MaskinCore, so the network client and Keychain store ARE in its
  binary (`StopTurnIntent` references them). They never run there: the system executes the
  intent's `perform()` in the app process.

## Known limits

- The foreground fallback only watches the conversation whose thread is open
  (`ChatStore.onSessionsRefreshed`). Other conversations rely on pushes.
- "Needs you" locally is inferred from a paused session; the server marks the real
  decision-point state, which only arrives via push.
