# Live Activities

Three activities, all for time-bound work only (handoff `specs/1-iPhone.md` → "Widgets and Live
Activities", `specs/8-Objects.md` → "Live Activity: agents working"). A decision waiting on the
reader is a widget and a notification, never a Live Activity.

| Activity | Attributes | Driven by | Status |
|----------|------------|-----------|--------|
| **Agents working** (aggregate, one per device) | `MaskinAgentsAttributes` | the workspace's running sessions + the open thread, in the foreground | live, this document |
| Flow cycle running | `MaskinCycleAttributes` | the flow list (`LoopsStore`), for flows the person follows | `CycleActivityController`, foreground only |
| Live meeting | `MaskinMeetingAttributes` | the live call (`LiveMeetingScreen`) | `MeetingActivityController`; Mute and End act on the call |
| Live call with an agent | `LiveCallActivityAttributes` | `LiveCallCenter` (the running call, polled once a second) | `CallActivityController`; Mute and End are `ToggleCallMuteIntent` / `EndCallIntent` (`Apps/LiveActivityShared/CallIntents.swift`) acting through `LiveCallControl`. Local only: no push. Card removed by the system or swiped away stays gone for the rest of the call; stale cards are ended at launch |

**Needs real-device verification**: the simulator renders the UI but does not deliver Live
Activity pushes, and ActivityKit token callbacks only fire on hardware.

## Agents working

One aggregate Lock Screen + Dynamic Island card for every agent doing time-bound work in the
signed-in workspace. Never one per agent or per session: iOS shows one card per app in the
island, and 20 cards would be noise.

| Agents | Compact island | Expanded island / Lock Screen |
|--------|----------------|-------------------------------|
| 1 | tile · level bars | "Forge is rolling out Retry policy v2", one progress line, a Patina bar, **Pause rolling out** · **Open** (the object, else the thread, else the agent) |
| 2+ | up to 3 stacked tiles · count · bars | "23 agents working · 3 finish in 15 min", the 3 rows closest to finishing (tile, who + what, time left), **Pause all** · **See all 23** (the Agents screen) |
| 0 (ending) | ink ✓ | "Agents finished", lingers 60 s, then dismisses |

Minimal: a single tile (1 agent) or the count. Rows rank by soonest expected finish, then
anything touching customers or production, then the longest-running agent. Brand rules: Patina
(`MaskinColor.sig`) only for the level bars, the working ring and the progress bar; actions are
ink capsules (`MaskinSurface.inverse` / `.onInverse`); done is ink ✓; no amber, green or red.
Agent tiles are `LiveActivityAgentTile` (first letter on the signal tint; the logo tile for the
platform agent), shared with the cycle and meeting cards.

The level bars are static. A Live Activity is rendered by the system from snapshots, so the
prototype's 0.8 s equaliser loop cannot run; nothing moves on its own, which also satisfies
Reduce Motion.

### Pieces

| Piece | Where |
|-------|-------|
| State, attributes, ranking, copy (`WorkingAgent`, `AgentsActivityState`, `AgentsActivityIdentity`, `MaskinAgentsAttributes`, `LiveTurn`) | `Sources/MaskinCore/LiveActivity/AgentsActivityState.swift` |
| Fold feed + open thread into one card, throttle, token registration | `Sources/MaskinCore/LiveActivity/AgentsActivityCoordinator.swift` (`TurnActivityCoordinator` is a typealias for callers that predate the rename) |
| Workspace-wide running sessions (`GET /api/actors` + `GET /api/sessions?verbose=true`, refetched on session/actor events) | `Sources/MaskinCore/LiveActivity/WorkingAgentsFeed.swift` |
| One feed per signed-in workspace; foreground/background refresh | `Sources/MaskinCore/LiveActivity/AgentsActivityRuntime.swift` |
| Pause (background API call, fan-out over `POST /api/sessions/{id}/pause`) | `Sources/MaskinCore/LiveActivity/SessionPauser.swift`, `Apps/LiveActivityShared/PauseAgentsIntent.swift` |
| ActivityKit hosts (iOS app): `AgentsActivityHost`, `CycleActivityHost`, `MeetingActivityHost` | `Apps/Maskin/AgentsActivityHost.swift`, wired in `MaskinApp.swift`; `BackgroundRefresh.swift` refreshes the feed |
| Token client for a future push path | `Sources/MaskinCore/LiveActivity/APILiveActivityTokens.swift` (inert: see "What this server cannot do yet") |
| UI extension target `MaskinLiveActivity` | `Apps/MaskinLiveActivity/{AgentsLiveActivity,CycleLiveActivity,MeetingLiveActivity,LiveActivityBrand}.swift`, `project.yml` |
| Deep links `maskin://<ws>/agents`, `maskin://<ws>/agents/<id>` | `Sources/MaskinCore/DeepLinks/DeepLink.swift`; handled in `AppRuntime.present` and `InternalLinkInfo` |

### Two inputs, one card

- **Feed** (`WorkingAgentsFeed`): every *non-interactive* session in `running` / `starting` /
  `pending`, one row per agent (the session that started first is the row). Interactive chat
  sessions are excluded on purpose: they stay `running` between turns, so the list cannot tell a
  thinking agent from an idle one.
- **Open thread** (`ChatStore.onSessionsRefreshed` → `LiveTurn.turns` →
  `TurnActivityCoordinator.shared?.reconcile`, unchanged call in `ChatsScreen`): a live session
  touched within the last 20 minutes (the same rule as `ChatStore.liveSessions`) is a working
  row; one that went quiet, ended, or `needsYou` (a decision, never a row) is dropped at once.
  Overlays expire after 10 minutes without a refresh (the thread was closed), and a session a
  thread reports finished is dropped even if the feed still lists it.

The activity starts when the first agent appears, updates on every change (at most one update
per second; the last change always lands), ends with the "Agents finished" state when the last
one goes, and is ended at once on sign-out or a workspace switch. A card the user swiped away
only comes back when a *new* agent starts.

### What this server cannot do yet

`main`'s API has no `/api/devices`, no `/api/live-activities/tokens` and no push-to-start
sender, so the card is **foreground only**: the app refreshes the feed when it comes to the
front, on session events while it is in front, and from `BackgroundRefresh` (best effort, iOS
decides when). The coordinator still forwards ActivityKit tokens and the `APILiveActivityTokens`
client still exists, but `APIDeviceRegistrar` never produces a device id on this server, so
nothing is ever registered. A card left behind when the app is suspended goes stale after 15
minutes (ActivityKit `staleDate`) and catches up on the next foreground.

### State JSON (the future push contract)

The JSON of `AgentsActivityState` and the attributes type name `MaskinAgentsAttributes` are what
a backend sender would have to emit. Dates use Swift's default `Date` coding (seconds since
2001-01-01T00:00:00Z); never put a date strategy on a coder that touches them.

```jsonc
{
  "aps": {
    "timestamp": 1760200000,
    "event": "start",                      // "start" | "update" | "end"
    "attributes-type": "MaskinAgentsAttributes",
    "attributes": { "workspaceId": "<uuid>" },
    "content-state": {
      "count": 23,                         // every agent working, not just the rows below
      "finishingSoon": 3,                  // of those, how many finish within 15 min of now
      "agents": [                          // ranked; at most 6 rows (APNs payload ≤ 4 KB)
        {
          "id": "<actor uuid>",
          "sessionId": "<session uuid>",   // what Pause acts on
          "name": "Forge",                 // ≤ 40 chars, never an id ("Agent" if unknown)
          "doing": "rolling out Retry policy v2",   // ≤ 80 chars, present participle
          "startedAt": 780000000.5,        // Swift reference seconds
          "expectedFinishAt": 780000900.5, // optional
          "touchesCustomersOrProduction": true,
          "objectId": "<uuid>",            // optional; Open target, first choice
          "conversationId": "<uuid>"       // optional; Open target, second choice
        }
      ]
    },
    "alert": { "title": "Forge", "body": "rolling out Retry policy v2" },   // start only
    "stale-date": 1760200900,             // start/update: now + 15 min
    "dismissal-date": 1760200060          // end only: now + 60 s
  }
}
```

Ranking (`AgentsActivityState.ranked`): soonest `expectedFinishAt` first (unknown last), then
`touchesCustomersOrProduction`, then earliest `startedAt`, then `id`. The app re-ranks whatever
it receives; `count` and `finishingSoon` are read as sent, and a payload without them is read as
"what you see is all".

### Backend follow-up (hand to a backend task)

1. **Device and token routes on `main`.** `POST /api/devices` (upsert on token + environment,
   the foundation #1864) and `POST/DELETE /api/live-activities/tokens`. The app already calls
   both through `APIDeviceRegistrar` and `APILiveActivityTokens`; restoring the generated
   `/api/devices` calls and regenerating `openapi.json` is the app-side half.
2. **One activity per device, per workspace.** Key update tokens by `(device_id, kind)` with a
   nullable `session_id` (the app registers its one update token with `session_id: null`); each
   new activity on a device mints a new token and the app deletes the previous one. Delete
   update tokens when the aggregate ends, not when a session completes.
3. **Content state** as above, built from every running non-interactive session in the workspace
   plus interactive sessions with a turn in flight (`SessionManager`'s `'turn'` events), grouped
   by actor, ranked, at most 6 rows, under 4 KB.
4. **Lifecycle.** Push-to-start when a workspace goes from 0 to ≥ 1 working agents for a
   recipient with no live update token; `update` on any change to the set or to a row's `doing`
   / `expectedFinishAt`; `end` with `count: 0` when the last agent finishes. Never raise an
   alert for `needs_input` on this activity (decisions are widgets and notifications).
5. **Throttle.** 5 s per (device, workspace) for updates (APNs priority 5); start and end bypass
   it (priority 10). Topic `io.maskin.app.push-type.liveactivity`.
   `NSSupportsLiveActivitiesFrequentUpdates` is already set.
6. **Recipient.** Every workspace member with a registered token for that workspace.
7. **Fields the app cannot derive and leaves empty** (the card degrades gracefully):
   `expectedFinishAt` (sessions have no ETA; a flow's typical cycle length would do),
   `touchesCustomersOrProduction` (nothing on a session says so), and `objectId` (the session row
   does not carry the object it works on; `conversationId` is only known for chat turns). Until
   then rows show elapsed time instead of time left, the headline omits "· k finish in m min",
   and Open goes to the thread or the agent.

## Flow cycle and live meeting

**Cycle.** `CycleActivityController` (MaskinCore) follows the flow list. `LoopsStore.refresh()` hands it
the loaded flows; `CycleActivityPlanner` (pure) decides start, update and end. A flow gets a card only
while it is running and the person turned it on under Notifications > Flows (stored per device in
`CycleOptInStorage`). The card shows the cycle running now (one past the cycles closed), progress from
closed work, and turns to NEEDS YOU when the flow waits on the viewer. State comes from the flow, never
a timer. `CycleActivityHost` (app target) does the ActivityKit calls. It updates only while the app is
open: background updates need the push path this server lacks. "Later" is `DismissCycleActivityIntent`.

**Meeting.** `LiveMeetingScreen` starts the card when the call connects (`MeetingActivityController`),
follows mute, and ends it when the screen closes. Mute and End are `LiveActivityIntent`s that act on the
live call through `MeetingCallControl`, which the screen registers while a call is up. End hangs up,
it does not only remove the card. There are no level bars: the call exposes no microphone level to the
activity.

## Manual steps (cannot be done from code)

1. **Info.plist**: `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates` are
   set on the app in `project.yml`. Confirm both appear in the built app's Info.plist.
2. **App ID for `io.maskin.app.liveactivity`**: register it in the developer portal (new
   extension bundle id). It needs no special capability; it is a WidgetKit extension.
3. Regenerate the project (`xcodegen generate`) and set `DEVELOPMENT_TEAM` in
   `Config/Local.xcconfig`.
4. On a device: Settings > Maskin > Live Activities must be on.

## Device checklist

- Start a flow run (non-interactive session) from the web with the app in front: the card
  appears with one tile; a second run adds a stacked tile and "2 agents working".
- Open a thread and send a message: the agent's turn joins the card and leaves when the reply
  lands; a paused (needs-you) session never appears.
- Pause on the Lock Screen: the agent's session pauses, its row leaves the card at once; "Pause
  all" pauses every row. A card from another workspace than the signed-in one pauses nothing.
- Open / See all: `maskin://<ws>/objects/<id>`, `/chats/<id>`, `/agents/<id>` or `/agents`
  land where they say, via `DeepLinkRouter`.
- Sign out: the card ends at once; switching workspace ends the old card and starts a fresh one.
- Swipe the card away: it stays gone until a new agent starts.
- Background the app: the card stays as last shown, reads stale after 15 min, and catches up on
  the next foreground (no pushes on this server).

## Sign-out, workspace switch and Pause

- `AgentsActivityCoordinator.signedOut` ends the card and `DELETE`s any registered token, using
  the ending session's credentials (the live session is already cleared by the time the requests
  go out). `workspaceChanged` ends the old card first: its agents, links and Pause targets belong
  to the old workspace.
- `SessionPauser` refuses when the Keychain session's workspace differs from the card's, so a
  card left over from another workspace can never pause sessions as the wrong identity. Ids are
  validated (`DeepLink.isSafeID`) before they reach a request.
- The extension target links MaskinCore, so the network client and Keychain store ARE in its
  binary (`PauseAgentsIntent` references them). They never run there: the system executes the
  intent's `perform()` in the app process.

## Known limits

- An agent with two running sessions shows once; Pause acts on the row's session (the one that
  started first) and leaves the other running.
- The chat overlay for a thread that was closed mid-turn lingers up to 10 minutes if nothing
  reports the turn finished; the feed cannot help because chat sessions read `running` while idle.
- No background updates on this server (see above).

## Sweep and topic

- **Sweep** (`AgentsActivitySweep`, `AgentsActivityCoordinator.sweep()`): runs after the workspace feed loads at launch, on foreground (`AgentsActivityRuntime.refresh`) and after a thread's sessions refresh. It ends cards from another workspace, cards left over when the loaded feed says nobody is working (a push-to-start whose end push never came), and duplicates. Until the feed has loaded it only touches other workspaces' cards.
- **Topic**: `WorkingAgent.topic` is the conversation title (optional, 60 characters); the expanded card appends it to the "Started …" line.
