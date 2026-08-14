# TestFlight release pipeline

Operational rails for pushing a signed Maskin iOS build to TestFlight for internal review before an App Store submission.

## What lives here

- `../../../.github/workflows/testflight.yml` — manual-dispatch GitHub Actions workflow (macos-14) that builds and uploads. Never runs on push/PR.
- `ExportOptions.plist` — App Store distribution export options for manual `xcodebuild -exportArchive` runs.
- `scripts/apply-gen-apple-tweaks.sh` — post-`tauri ios init` fix-ups (production aps-environment, AppIcon compilation) for the git-ignored `apps/native/src-tauri/gen/apple/` tree.
- `test-information.md` — copy-paste text for App Store Connect's TestFlight *Test Information* screen.
- `review-checklist.md` — sign-off list an internal tester walks once the build installs.

Building the shell itself (Rust, JS, Tauri config) lives under `apps/native/`. See `apps/native/README.md` for the dev-loop and on-device install path.

## Prerequisites (one time, done by a human with App Store Connect access)

### 1. Enrol in the paid Apple Developer Program

Bundle id `io.maskin.mobile` needs a paid team. The mobile README notes that a free/personal Apple ID is enough to sideload the app in development, but TestFlight and the App Store both require the paid programme.

### 2. Create the App Store Connect record

In App Store Connect → *Apps* → *+* → *New App*:

- Platform: **iOS**
- Bundle ID: **io.maskin.mobile** (must already be registered on developer.apple.com under the paid team)
- Primary language, name (`Maskin`), and SKU (any stable id, e.g. `io.maskin.mobile`)

Once created, the app appears in *TestFlight* with no builds. The first upload from CI populates it.

### 3. Create the internal tester group

*TestFlight* → *Internal Testing* → *+* → name it `Internal Review`. Add every internal reviewer (App Store Connect users, not arbitrary emails). Internal builds skip Apple review and become installable within minutes.

### 4. Distribution certificate and provisioning profile

On a Mac with Xcode:

1. *Xcode → Settings → Accounts*: sign in with an Apple ID that belongs to the paid team.
2. *Manage Certificates → + → Apple Distribution*. Export the resulting cert as a `.p12` (Keychain Access → right-click → Export). Set a password — that's `IOS_DIST_CERT_PASSWORD` below.
3. On developer.apple.com → *Certificates, Identifiers & Profiles → Profiles → + → App Store*, select the app id and the distribution cert, and download the `.mobileprovision`.

Base64-encode both for the GitHub secrets:

```sh
base64 -i dist.p12 | pbcopy   # → IOS_DIST_CERT_P12_BASE64
base64 -i maskin-appstore.mobileprovision | pbcopy   # → IOS_APPSTORE_PROVISIONING_PROFILE_BASE64
```

### 5. App Store Connect API key

*App Store Connect → Users and Access → Integrations → Team Keys → + → Generate API Key*, role **App Manager** (needed to upload builds). Download the `.p8` file once — Apple won't offer it again.

```sh
base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # → APPSTORE_PRIVATE_KEY_BASE64
```

The Key ID and Issuer ID are shown on the same screen.

### 6. Repository secrets and variables

GitHub → repo → *Settings → Secrets and variables → Actions*.

| Secret | Source |
| --- | --- |
| `APPLE_DEVELOPMENT_TEAM` | 10-char team id from developer.apple.com → *Membership* |
| `APPSTORE_ISSUER_ID` | UUID from App Store Connect *Integrations → Team Keys* |
| `APPSTORE_KEY_ID` | 10-char id shown next to the key |
| `APPSTORE_PRIVATE_KEY_BASE64` | base64 of the `.p8` |
| `IOS_DIST_CERT_P12_BASE64` | base64 of the exported `.p12` |
| `IOS_DIST_CERT_PASSWORD` | password chosen when exporting the `.p12` |
| `IOS_APPSTORE_PROVISIONING_PROFILE_BASE64` | base64 of the `.mobileprovision` |
| `KEYCHAIN_PASSWORD` | any string — used for the temporary CI keychain only |

| Variable | Source |
| --- | --- |
| `MASKIN_MOBILE_API_BASE_URL` | absolute URL of the backend the app talks to on-device (e.g. `https://api.maskin.io`) |

Every secret name is enforced in the workflow's fail-fast step — a missing one halts the run before any signing material is touched.

## Cut a TestFlight build via CI

1. Actions → *iOS TestFlight upload* → *Run workflow*.
2. Optionally set *release_notes* (short — the runbook's `test-information.md` is the full test plan).
3. The workflow: checks out, installs Rust/Node/pnpm, imports signing material into a scratch keychain, generates the Xcode project (`tauri ios init`), applies the two post-init tweaks, pins `CFBundleVersion` to the run number, runs `tauri ios build --export-method app-store-connect`, validates the `.ipa`, and uploads via `xcrun altool`.
4. Apple emails the App Store Connect team when the build finishes processing (5–20 min). It then appears under *TestFlight → iOS* as installable to the *Internal Review* group.
5. In App Store Connect, paste `test-information.md` into the build's *What to Test* / *Test Information* fields (Apple caches these across builds, so this is a one-time step per marketing version).

## Cut a TestFlight build manually (Mac, no CI)

Useful for a one-off release, or when the workflow itself is broken.

```sh
# 0. Prereqs (Node ≥ 20, pnpm, Rust, Xcode, CocoaPods via Homebrew).
#    See apps/native/README.md for the base install.
cd apps/native
export APPLE_DEVELOPMENT_TEAM=ABCD123456
export VITE_API_BASE_URL=https://api.maskin.io

# 1. Generate the Xcode project.
pnpm ios:init

# 2. Apply the two known post-init fix-ups (documented in apps/native/README.md).
bash ios-testflight/scripts/apply-gen-apple-tweaks.sh

# 3. Pin marketing/build version.
INFO_PLIST=src-tauri/gen/apple/maskin-mobile_iOS/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $(node -p 'require(\"./src-tauri/tauri.conf.json\").version')" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date +%s)" "$INFO_PLIST"   # any strictly increasing integer works

# 4. Archive and export using this repo's ExportOptions.plist.
pnpm exec tauri ios build --target aarch64-apple-ios --export-method app-store-connect

# 5. Upload. Requires an App Store Connect API key on disk at
#    ~/private_keys/AuthKey_<KEY_ID>.p8 (chmod 600).
IPA=$(find src-tauri/gen/apple/build -name '*.ipa' | head -1)
xcrun altool --upload-app --type ios --file "$IPA" \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

Or, if you prefer Xcode's Organizer: open `apps/native/src-tauri/gen/apple/*.xcodeproj`, *Product → Archive*, then *Distribute App → App Store Connect → Upload*. The Organizer handles signing and upload interactively.

## Internal review handoff

Once the build appears in TestFlight and reviewers have installed it via the TestFlight iOS app:

1. Paste the `review-checklist.md` contents into the bet's comments as a fresh checklist, or open a follow-up task on the bet titled *TestFlight build N — internal review sign-off*.
2. Each reviewer replies with pass/fail per line.
3. When at least one reviewer has walked the full list and every line passes, the DoD line *"at least one internal reviewer has confirmed the build installs and core flows work"* is closed. Record the reviewer name and build number in the bet's Ship Notes.

## Troubleshooting

- **`code signing is required for product type 'Application'`** — `APPLE_DEVELOPMENT_TEAM` isn't propagating into the pbxproj. Confirm the env var was exported *before* `pnpm ios:init` ran (Tauri seeds `DEVELOPMENT_TEAM` at generation time). Regenerate with `rm -rf apps/native/src-tauri/gen/apple && pnpm ios:init`.
- **`No matching provisioning profiles found`** — the profile installed in `~/Library/MobileDevice/Provisioning Profiles/` doesn't cover `io.maskin.mobile` + this cert. Re-download from developer.apple.com and re-encode.
- **`altool: Unable to authenticate`** — the `.p8` file must be at `~/private_keys/AuthKey_<KEY_ID>.p8` (or one of the other paths documented at [altool auth](https://help.apple.com/asc/appsaltool/)). The workflow places it there automatically; for manual runs, do the same.
- **Build number rejected by App Store Connect** — Apple requires `CFBundleVersion` to strictly increase within a marketing version. If two workflow runs collide, bump `version` in `apps/native/src-tauri/tauri.conf.json` (e.g. `0.1.0` → `0.1.1`) or re-run — `GITHUB_RUN_NUMBER` is monotonic, so a fresh run always wins.
- **App uploads but never appears in TestFlight** — check email for an Apple processing failure (missing icon, invalid entitlement, ITMS-90xxx). The AppIcon and aps-environment tweaks are the two most common causes; both are handled by `apply-gen-apple-tweaks.sh`, but confirm the script actually ran (workflow logs, look for `Set aps-environment=production`).
