#!/bin/sh
# Release builds must not ship the cleartext-HTTP exception for localhost (it exists only for the
# dev backend). Runs as a post-compile phase on every app target, after Info.plist is processed
# and before code signing. Debug is left untouched.
set -eu
[ "${CONFIGURATION:-}" = "Release" ] || exit 0
PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
[ -f "$PLIST" ] || exit 0
/usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
