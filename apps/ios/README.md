# Maskin iOS

Native SwiftUI client for Maskin (iOS 17+). See the repo root `CLAUDE.md` for how this
fits into the rest of the monorepo.

## Setup

The `.xcodeproj` is generated from `project.yml` via [XcodeGen](https://github.com/yonaskolb/XcodeGen)
and is gitignored — regenerate it after cloning or whenever a Swift file is added/moved:

```bash
brew install xcodegen   # one-time
cd apps/ios
xcodegen generate
open Maskin.xcodeproj
```

Regenerate again any time you add, remove, or move a source file — XcodeGen enumerates
files at generation time, so new files aren't picked up automatically.

## Running against the backend

Start the backend first (`pnpm dev` from the repo root — see root `CLAUDE.md`).

- **Simulator**: works out of the box. `Core/Networking/DevServer.swift` defaults to
  `localhost`, which the Simulator shares with the host Mac.
- **Physical device**: edit `DevServer.host` in that same file to your Mac's LAN IP
  (`ipconfig getifaddr en0`), and make sure the phone and Mac are on the same network.
  **Don't commit your IP** — it's personal to your network. Also requires signing (next
  section) and, on the phone, trusting the developer certificate under Settings →
  General → VPN & Device Management.

## Signing for a physical device

No Apple Developer team id is checked into this repo — every contributor has their own.
`CODE_SIGN_STYLE: Automatic` is set in `project.yml`, so after generating the project,
either:

- Open Xcode → select the `Maskin` target → Signing & Capabilities → pick your team, or
- Build from the CLI with `-allowProvisioningUpdates`, which uses whatever Apple ID
  Xcode already has signed in:
  ```bash
  xcodebuild -project Maskin.xcodeproj -scheme Maskin \
    -destination 'platform=iOS,name=<your device name>' \
    -allowProvisioningUpdates build
  ```

Simulator builds don't need a team at all.

## Tests

```bash
xcodebuild -project Maskin.xcodeproj -scheme Maskin \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaskinTests test
```

`MaskinTests` includes parity checks (`ActorAvatarParityTests`, `CardClassifierTests`)
that assert Swift ports of web logic (`actor-avatar.tsx`'s hash, `foryou-card-kind.ts`'s
classifier) stay bit-for-bit identical to their TypeScript counterparts.
