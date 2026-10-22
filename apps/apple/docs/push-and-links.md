# Push notifications, deep links, and what must be set up outside the repo

## What the repo now does
| Capability | Where |
|---|---|
| `aps-environment` (`development` Debug / `production` Release, via `MASKIN_APS_ENVIRONMENT`) | iOS: `Apps/Maskin/Maskin.entitlements`; macOS: `com.apple.developer.aps-environment` in `Apps/Maskin/Maskin-macOS.entitlements` |
| `UIBackgroundModes: remote-notification` | `project.yml` (Maskin Info) |
| `maskin://` URL scheme | `CFBundleURLTypes` in `project.yml` |
| Universal links `applinks:maskin.io` | both entitlements files |
| Cleartext `localhost` ATS exception | Debug only; `scripts/strip-dev-ats.sh` removes it from Release for Maskin, MaskinWatch, MaskinTV |
| macOS entitlements | Release only by default (restricted entitlements kill unsigned/ad-hoc builds). Debug: set `MASKIN_MACOS_ENTITLEMENTS=Apps/Maskin/Maskin-macOS.entitlements` + `DEVELOPMENT_TEAM` for a signed local build |

Keychain: items are `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (out of backups; no sync is needed
because every device signs in itself). macOS uses the data-protection keychain and falls back to the
legacy keychain when the build is unsigned (`errSecMissingEntitlement`). Items written before this change
keep their old accessibility until the next sign-in rewrites them.

watchOS and tvOS have no push/URL entitlements here: the backend's single APNs topic is the iOS/macOS bundle id.

## Must be done in the Apple Developer portal / by a maintainer
1. Set the Team ID: `DEVELOPMENT_TEAM` (project.yml has a TODO). Needed for every signed build.
2. Enable **Push Notifications** and **Associated Domains** on App ID `io.maskin.app` (macOS uses the same ID); regenerate provisioning profiles.
3. Create an APNs auth key (.p8) and give the backend its key id, team id, topic (`io.maskin.app`) and key (see `apps/dev/src/services/apns.ts` env vars).
4. Host the AASA file below. Personal (free) teams cannot use Push or Associated Domains, so a device build with a personal team will fail to sign.

## Rich pushes (notification service extension)
`apps/dev/src/services/apns.ts` (`buildApnsPayload`) is the one place that writes the payload; `Apps/MaskinNotificationService` reads exactly these keys.

| Key | Meaning | Who acts on it |
|---|---|---|
| `aps.mutable-content: 1` | every push passes through the extension | iOS |
| `aps.thread-id` | `chat:<id>` / `object:<id>` / `workspace:<id>` grouping | iOS |
| `aps.interruption-level` | `time-sensitive` for decisions and `needs_input`, `active` otherwise, `passive` (no sound, apns-priority 5) when asked | iOS |
| `aps.badge` | the actor's pending notifications (the app overwrites it with its own unread count when it runs) | iOS |
| `aps.category` + root `decision` | decision buttons (the agent's option labels) plus Reply | extension builds a per-notification category |
| root `image_url` | https image (<= 5 MB, 12 s timeout) attached to the banner. No producer yet: `PushMessage.imageUrl` exists, nothing sets it | extension |

Failure behaviour: a bad payload, a failed or slow download, or the ~30 s budget expiring all still deliver the notification with whatever was ready (the decision category is set synchronously, the image is best effort).
Time-sensitive delivery needs the `com.apple.developer.usernotifications.time-sensitive` entitlement on the app and the "Time Sensitive Notifications" capability on App ID `io.maskin.app` (enabled 2026-10). It is in the iOS `Maskin.entitlements`; with automatic signing Xcode refreshes the provisioning profile on the next build. If a signed build fails with "profile doesn't include the time-sensitive entitlement", open Xcode > Settings > Accounts > Download Manual Profiles (or toggle automatic signing) once. Without the entitlement iOS silently treats those pushes as `active`. It is not in `Maskin-macOS.entitlements`: that file is Release-only and restricted, and nothing here needs it on macOS.

## Notification preferences, timezone, permission timing (client)
- Settings > Notifications (`NotificationPreferencesSection`) edits `GET/PUT /api/notification-preferences`: Needs you is shown as "Always on" (not a switch; a workspace mute is the only way to quiet it, and even then decisions still arrive without breaking through Focus), Chat replies / Digests / Tips toggles, quiet hours (off by default), the daily briefing and its time, and a mute list of workspace names. Changes are optimistic with rollback and carry an `Idempotency-Key`. The PUT is hand-encoded (`NotificationPreferencesPatch.jsonBody`) because the generated payload cannot send `null`, which is how quiet hours and the timezone are cleared.
- Timezone: `AppRuntime.syncTimezone()` reads the server value once, and PUTs `TimeZone.current.identifier` only when it differs. It runs at sign-in, every foreground and on `NSSystemTimeZoneDidChange`, never blocks, never shows an error, and simply retries on the next trigger.
- Permission timing: nothing prompts at first launch or on opening Chats. After the first moment of value (a decision card in For you, or an agent reply in a chat) `NotificationPromptCoordinator` shows the in-app sheet "Get told when an agent needs a decision"; only "Turn on notifications" calls `requestAuthorization`. "Not now" (or swiping it away) is remembered for 7 days (`NotificationPromptPolicy`). Devices already authorized see nothing new and keep registering for remote notifications at launch.
- Chat pushes: `aps.thread-id` (`chat:<id>`) groups them in Notification Center (iOS does this itself) and `deep_link` `maskin://<ws>/chats/<id>` opens the chat through `PushAppDelegate.receiveTap` > `DeepLinkRouter` (tested in `ServerPushContractTests`).

## Device registration (how the APNs token reaches the backend)
Sequence: sign in (`AppRuntime.actorChanged` > `PushRegistrar.actorChanged`) > if notifications are authorized, `registerForRemoteNotifications` > iOS calls `PushAppDelegate.didRegisterForRemoteNotificationsWithDeviceToken` > `PushRegistrar.didReceive(deviceToken:)` hex-encodes it > `APIDeviceRegistrar.register` sends `POST /api/devices` `{platform, apns_token, environment, app_version}` (Bearer key, `Idempotency-Key`, no `X-Workspace-Id`) and keeps the returned device id. A device that has not decided yet registers right after "Turn on notifications" in the in-app sheet (`requestAuthorization` > token > upload). Every foreground re-runs the same steps (`PushRegistrar.foregrounded`), so a failed upload, a rotated token or a permission switched on in iOS Settings is picked up; an unchanged token is not re-uploaded. Sign-out sends `DELETE /api/devices/{id}` by device id (never the token) before credentials are cleared; a failed attempt is kept and retried at the next sign-in.
`environment` is `sandbox` for the simulator, DEBUG builds and anything whose embedded provisioning profile says `development`; otherwise `production` (TestFlight/App Store). A sandbox token is only deliverable by the backend if it is configured for the sandbox gateway.

How to verify registration: on a simulator or device, sign in, open a chat or For you until the notification sheet appears, tap "Turn on notifications" and allow. Then count the row, for the signed-in actor:
`SELECT platform, environment, app_version, last_seen_at FROM device_tokens WHERE actor_id = '<actor>' ORDER BY last_seen_at DESC;` (production had 0 rows before this fix). There is no GET route, so the observable client side is: the row above, a `device` `created`/`updated` event in the workspace event history (entity_type `device`), and `PushRegistrar.registration == .registered` in the debugger. A `.failed` state with APNs error text means iOS refused the token (missing Push capability / provisioning); a missing row with no failure means the permission was not granted or the sheet never appeared. Simulators do get a token (iOS 16+) but APNs cannot deliver to them with a real key; use `xcrun simctl push` for display tests.

## Share extension and the offline queue
`Apps/MaskinShare` sends a link, text, image or file into Maskin as a new object, files only, or a chat message, in a workspace of the user's choosing. When the network is down it parks the share in the App Group container (`ShareQueue`, `group.io.maskin.app`, at most 20 shares / 14 days) and the app sends it on the next foreground (`AppRuntime.scenePhaseChanged`, `ShareQueueDrainer`). Each share keeps its Idempotency-Key base, so a retry never duplicates anything the extension already created.
Portal: enable **App Groups** with `group.io.maskin.app` on `io.maskin.app` and `io.maskin.app.share`, plus **Keychain Sharing** on the share App ID. Without the group the extension still works online and reports "couldn't be saved for later" offline.

## Apple App Site Association
Serve at `https://maskin.io/.well-known/apple-app-site-association`: HTTPS, **no redirect**,
`Content-Type: application/json`, no file extension. The web host's SPA catch-all must not shadow it.
Replace `TEAMID` with the Apple Team ID. The app declares only `maskin.io`: `www.maskin.io` 301s to the apex and
Apple does not follow redirects, and `app.maskin.io` has no DNS record. The backend builds it in `apps/dev/src/lib/apple-app-site-association.ts`;
the JSON below is what that serves. Paths come from the web routes
`/{workspaceId}/objects/{objectId}`, `/{workspaceId}/chats/{id}` and the workspace inbox
`/{workspaceId}/notifications` (see `DeepLink.swift`), plus workspace invitations,
`/invite?token=<raw>` (see `InviteLink.swift`); the `?token` query component means a bare `/invite` stays in
the browser. The app ignores any other path, but listing only these keeps everything else opening in the browser.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.io.maskin.app"],
        "components": [
          { "/": "/invite", "?": { "token": "?*" } },
          { "/": "/*/objects/*" },
          { "/": "/*/chats/*" },
          { "/": "/*/notifications" }
        ]
      }
    ]
  }
}
```

Verify: `curl -sI https://maskin.io/.well-known/apple-app-site-association` (200, application/json),
then on a device `xcrun simctl openurl booted https://maskin.io/<workspaceId>/objects/<id>` (simulator
needs `applinks:maskin.io?mode=developer` or a real install). `xcrun simctl openurl booted maskin://<workspaceId>/objects/<id>` tests the custom scheme with no hosting.

## Invitation links
`https://maskin.io/invite?token=<raw>` and `maskin://invite?token=<raw>` open the invite screen
(`MaskinFeatures/Invites/InviteView.swift`). `InviteCoordinator` keeps the token in `UserDefaults` (`invite.pending.v1`, at most 7 days)
so it survives sign-in and a cold launch; it is forgotten on Accept, Decline, a dead invite, or closing the screen while signed in.
Signed in, Accept posts `POST /api/invites/{token}/accept` with the stored key and no `X-Workspace-Id`, then switches to the returned
workspace. A different signed-in email than the invited one asks first. Signed-out people without an account see a pointer to maskin.io:
`InviteStore.createAccount` is the single hook FE-2 (native sign-up) sets to start account creation instead.
Test: `xcrun simctl openurl booted "maskin://invite?token=<raw>"`.
