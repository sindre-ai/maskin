#!/bin/sh
# Rebuilds Sources/MaskinFeatures/Computer/Resources/novnc-bridge.js from entry.js and the same
# noVNC version the web app uses (apps/web/package.json). The bundle is checked in.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
cp "$here/entry.js" "$tmp/"
cd "$tmp"
npm init -y >/dev/null
npm i --silent @novnc/novnc@1.5.0 esbuild
npx esbuild entry.js --bundle --format=iife --minify --target=safari16 --outfile=novnc-bridge.js
out="$here/../../Sources/MaskinFeatures/Computer/Resources"
cp novnc-bridge.js "$out/novnc-bridge.js"
cp node_modules/@novnc/novnc/LICENSE.txt "$out/novnc-LICENSE.txt"
rm -rf "$tmp"
