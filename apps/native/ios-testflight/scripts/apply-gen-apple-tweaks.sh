#!/usr/bin/env bash
# Apply the two known post-`tauri ios init` fix-ups to the git-ignored
# apps/native/src-tauri/gen/apple/ tree, so a TestFlight archive builds
# cleanly without a human editing the generated Xcode project by hand.
#
# Fix 1 — AppIcon compilation.
#   `tauri ios init` doesn't set ASSETCATALOG_COMPILER_APPICON_NAME in the
#   generated project.yml, so Xcode never compiles Assets.xcassets and the
#   installed app has no home-screen icon. See the AppIcon troubleshooting
#   note in apps/native/README.md for the full context.
#
# Fix 2 — production APNs environment.
#   The entitlements template checked in on the bet branch ships with
#   aps-environment=development, which is correct for a dev build against
#   sandbox APNs. For TestFlight/App Store distribution the entitlement
#   must be flipped to `production`, otherwise the App Store validator
#   rejects the upload with an APNS environment error.
#
# Both fixes are idempotent — safe to re-run on an already-tweaked project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GEN_APPLE="$APP_ROOT/src-tauri/gen/apple"
PROJECT_YML="$GEN_APPLE/project.yml"
ENTITLEMENT_CANDIDATES=(
  "$GEN_APPLE/maskin-mobile_iOS/maskin-mobile_iOS.entitlements"
  "$APP_ROOT/src-tauri/ios/maskin.entitlements"
)

if [ ! -f "$PROJECT_YML" ]; then
  echo "apply-gen-apple-tweaks: $PROJECT_YML not found — run 'pnpm --filter @maskin/native ios:init' first" >&2
  exit 1
fi

# --- Fix 1: AppIcon compilation ------------------------------------------------

if grep -q 'ASSETCATALOG_COMPILER_APPICON_NAME' "$PROJECT_YML"; then
  echo "apply-gen-apple-tweaks: ASSETCATALOG_COMPILER_APPICON_NAME already set — skipping"
else
  PROJECT_YML="$PROJECT_YML" python3 - <<'PY'
import os, re, sys, pathlib

p = pathlib.Path(os.environ['PROJECT_YML'])
src = p.read_text()

# Match the target block's `settings: / base:` header once, then inject one
# indented line beneath it. `re.DOTALL` lets `.` cross newlines so the
# intervening YAML keys between the target name and settings.base don't
# break the match.
pattern = re.compile(
    r'(maskin-mobile_iOS:.*?settings:\s*\n\s+base:\s*\n)',
    re.DOTALL,
)
m = pattern.search(src)
if not m:
    print(
        'apply-gen-apple-tweaks: could not locate maskin-mobile_iOS.settings.base '
        f"in {p} — apply the AppIcon fix manually per apps/native/README.md",
        file=sys.stderr,
    )
    sys.exit(1)

insert = m.end()
after = src[insert:]
indent_match = re.match(r'(\s+)\S', after)
indent = indent_match.group(1) if indent_match else '        '
p.write_text(src[:insert] + f'{indent}ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon\n' + src[insert:])
print(f'apply-gen-apple-tweaks: injected ASSETCATALOG_COMPILER_APPICON_NAME into {p}')
PY

  # Regenerate .pbxproj from the updated project.yml if xcodegen is on PATH.
  # tauri ios init installs xcodegen as a prereq, so this is usually present
  # on any machine where the previous step succeeded.
  if command -v xcodegen >/dev/null 2>&1; then
    (cd "$GEN_APPLE" && xcodegen generate --spec project.yml)
  else
    echo "apply-gen-apple-tweaks: xcodegen not on PATH — .pbxproj not regenerated. Install with 'brew install xcodegen' and rerun, or edit the .pbxproj by hand per apps/native/README.md." >&2
  fi
fi

# --- Fix 2: production aps-environment ----------------------------------------

ENTITLEMENT=''
for candidate in "${ENTITLEMENT_CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    ENTITLEMENT="$candidate"
    break
  fi
done

if [ -z "$ENTITLEMENT" ]; then
  echo "apply-gen-apple-tweaks: no entitlements file found under gen/apple/ or src-tauri/ios/ — skipping aps-environment tweak. This is expected until task 1 (APNs spike) lands on the branch." >&2
  exit 0
fi

if /usr/libexec/PlistBuddy -c 'Print :aps-environment' "$ENTITLEMENT" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Set :aps-environment production' "$ENTITLEMENT"
else
  /usr/libexec/PlistBuddy -c 'Add :aps-environment string production' "$ENTITLEMENT"
fi
echo "apply-gen-apple-tweaks: set aps-environment=production in $ENTITLEMENT"
