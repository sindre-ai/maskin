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

## Apple App Site Association
Serve at `https://maskin.io/.well-known/apple-app-site-association`: HTTPS, **no redirect**,
`Content-Type: application/json`, no file extension. The web host's SPA catch-all must not shadow it.
Replace `TEAMID` with the Apple Team ID. Paths come from the web routes
`/{workspaceId}/objects/{objectId}`, `/{workspaceId}/chats/{id}` and the workspace inbox
`/{workspaceId}/notifications` (see `DeepLink.swift`); the app ignores any other path, but listing only
these keeps everything else opening in the browser.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.io.maskin.app"],
        "components": [
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
