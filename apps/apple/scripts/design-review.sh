#!/usr/bin/env bash
# Builds a Debug app for a simulator, signs it in to the demo workspace and screenshots it, so a
# screen can be compared with its design screenshot. The demo server must be running:
#   node apps/apple/scripts/demo-server/server.mjs
#
#   scripts/design-review.sh watch needs-you           # watch | tv | ipad, then a name for the file
#   MASKIN_DEMO_PAGE=briefing scripts/design-review.sh watch briefing
#
# Screenshots land in /tmp/review/<platform>/<name>.png. Debug builds only: the sign-in hook is
# compiled out of Release.
set -euo pipefail
cd "$(dirname "$0")/.."
platform="${1:?watch | tv | ipad}"
name="${2:?file name}"
out="/tmp/review/$platform"
mkdir -p "$out"

case "$platform" in
	watch) scheme=MaskinWatch; device=98538D70-3CFC-45ED-BD1B-FAA8033384BB; products=Debug-watchsimulator ;;
	tv) scheme=MaskinTV; device=575F3515-7B27-4A05-97DD-D2C334F617BD; products=Debug-appletvsimulator ;;
	ipad) scheme=Maskin; device=B1718F45-7069-424B-BB85-A226F7579DF8; products=Debug-iphonesimulator ;;
	*) echo "unknown platform $platform" >&2; exit 2 ;;
esac

case "$platform" in
	watch) dest="platform=watchOS Simulator,id=$device" ;;
	tv) dest="platform=tvOS Simulator,id=$device" ;;
	ipad) dest="platform=iOS Simulator,id=$device" ;;
esac

if [ -z "${SKIP_BUILD:-}" ]; then
	xcodebuild -project Maskin.xcodeproj -scheme "$scheme" -destination "$dest" \
		-configuration Debug CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" | sort -u
fi

app=$(find ~/Library/Developer/Xcode/DerivedData -path "*/$products/Maskin.app" -maxdepth 6 | head -1)
bundle=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Info.plist")
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl install "$device" "$app"
xcrun simctl terminate "$device" "$bundle" 2>/dev/null || true

session='{"apiKey":"ank_demo","actorId":"00000000-0000-4000-8000-000000000002","name":"Sindre Aasen","email":"sindre@northwind.example","workspaceId":"00000000-0000-4000-8000-000000000001"}'
env_args=(SIMCTL_CHILD_MASKIN_DEMO_SESSION="$session")
for v in MASKIN_DEMO_PAGE MASKIN_DEMO_SCREEN MASKIN_DEMO_TAB; do
	if [ -n "${!v:-}" ]; then env_args+=("SIMCTL_CHILD_$v=${!v}"); fi
done
env "${env_args[@]}" xcrun simctl launch "$device" "$bundle" >/dev/null
sleep "${WAIT:-12}"
xcrun simctl io "$device" screenshot "$out/$name.png" 2>&1 | tail -1
