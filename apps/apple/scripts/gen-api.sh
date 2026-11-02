#!/usr/bin/env bash
# Regenerates Sources/MaskinAPI/Generated from openapi.json + openapi-generator-config.yaml.
# The output is checked in (not built by a SwiftPM plugin) because a build-tool plugin used by both
# the iOS app and its embedded watchOS app writes to the same intermediate path, which Xcode
# rejects ("Multiple commands produce ...GeneratedSources/Types.swift").
# CI runs this and fails on any diff, so a stale client can't merge.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=Sources/MaskinAPI/Generated
rm -rf "$OUT"
mkdir -p "$OUT"
swift run --package-path . swift-openapi-generator generate \
	Sources/MaskinAPI/openapi.json \
	--config Sources/MaskinAPI/openapi-generator-config.yaml \
	--output-directory "$OUT"
