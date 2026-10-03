# Installing on a real device

## One-time setup

1. `cp Config/Local.xcconfig.example Config/Local.xcconfig` and set `DEVELOPMENT_TEAM` (gitignored).
   Without it the project builds unsigned (CI uses `CODE_SIGNING_ALLOWED=NO`).
2. `xcodegen generate` (the `.xcodeproj` is generated and gitignored).
3. Find the device: `xcrun devicectl list devices` (use the UDID / identifier it prints).

## Teams without Push / Associated Domains on the App ID

`Maskin.entitlements` (the default) needs the **Push Notifications** and **Associated Domains**
capabilities on the `io.maskin.app` App ID. A team that has not enabled them fails the install with
"requires a provisioning profile with the Associated Domains and Push Notifications features".

For a device test without those, add to `Config/Local.xcconfig`:

```
MASKIN_IOS_ENTITLEMENTS = Apps/Maskin/Maskin-nopush.entitlements
```

This keeps only the keychain group. Push registration and `https://maskin.io` universal links do not
work in that configuration; `maskin://` links still do.

**Set it in the xcconfig, never as a `CODE_SIGN_ENTITLEMENTS=...` command-line override.** A command-line
build setting applies to every target in the build, including the Swift package dependency targets,
and breaks them.

## Build, install, launch (worked on iPhone 13, Mesh Firm team)

```sh
cd apps/apple
xcodebuild -project Maskin.xcodeproj -scheme Maskin -configuration Debug \
  -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates \
  -skipPackagePluginValidation -skipMacroValidation \
  MASKIN_API_BASE_URL=https://maskin.io build

xcrun devicectl device install app --device <id> \
  <DerivedData>/Build/Products/Debug-iphoneos/Maskin.app
xcrun devicectl device process launch --device <id> io.maskin.app
```

`MASKIN_API_BASE_URL` on the command line is safe (read only by the app's Info.plist). The Debug
default is `http://localhost:3000`, which a phone cannot reach. `<DerivedData>` is printed by
`xcodebuild -showBuildSettings | grep TARGET_BUILD_DIR`, or pass `-derivedDataPath`.

## macOS

Debug builds are ad-hoc signed and carry no restricted entitlements so they launch unsigned. For push
or universal links in a signed Mac build set `MASKIN_MACOS_ENTITLEMENTS=Apps/Maskin/Maskin-macOS.entitlements`
together with `DEVELOPMENT_TEAM` in `Config/Local.xcconfig`.

## Watch and tvOS

- **Watch** is a standalone watch-only app (`WKApplication` + `WKWatchOnly`, no companion iOS
  bundle id): it signs in on the watch and does not need the iPhone app. Install it by selecting the
  `MaskinWatch` scheme/destination for a paired watch in Xcode.
- **tvOS** (`MaskinTV`): same signing flow with a tvOS destination.

## Release checklist (outside the repo)

- Enable Push Notifications + Associated Domains on the App ID; App Store Connect records for
  `io.maskin.app`, `io.maskin.app.watchkitapp`, `io.maskin.app.tv`.
- Privacy nutrition label must match `Apps/*/PrivacyInfo.xcprivacy`: Email Address, User ID,
  Other User Content (all linked, app functionality, no tracking); iOS/macOS also Device ID (APNs token).
- Review the generated tvOS/watch art (`scripts/gen-app-icons.swift` regenerates it).
- Confirm `https://maskin.io` is the production API origin.
