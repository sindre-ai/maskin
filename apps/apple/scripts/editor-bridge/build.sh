#!/bin/sh
# Rebuilds Sources/MaskinFeatures/Objects/EditorPage/{editor.html,editor-bridge.js,editor-bridge.css}
# from entry.tsx, the shared markdown package and the web app's app.css (so the page looks like the
# web editor). The output is checked in. Run from anywhere; needs `pnpm install` at the repo root.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="$root/apps/apple/Sources/MaskinFeatures/Objects/EditorPage"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$tmp"
npm init -y >/dev/null
npm i --silent esbuild@0.25 tailwindcss@4 @tailwindcss/cli@4 @tailwindcss/typography@0.5

mkdir -p "$out"

# JS: resolve react and tiptap from the markdown package, alias the editor to its source.
NODE_PATH="$root/packages/markdown/node_modules" npx esbuild "$here/entry.tsx" --bundle --format=iife --minify \
	--target=safari16 --jsx=automatic --define:process.env.NODE_ENV='"production"' \
	--alias:@maskin/markdown/react/editor="$root/packages/markdown/src/react/editor.tsx" \
	--outfile="$tmp/editor-bridge.js"

# CSS: the web app's stylesheet without its webfonts (the page uses the system font), with the
# markdown package as the only place utility classes are scanned.
node -e '
const fs = require("fs");
let css = fs.readFileSync(process.argv[1], "utf8");
css = css.replace(/@font-face\s*\{[^}]*\}/g, "");
css = css.replace(/@source\s+"[^"]*";/, "@source \"" + process.argv[2] + "\";");
css = css.replace(/@plugin\s+.@tailwindcss\/typography.;/, "@plugin \"@tailwindcss/typography\";");
css += "\n" + fs.readFileSync(process.argv[3], "utf8");
fs.writeFileSync("input.css", css);
' "$root/apps/web/src/app.css" "$root/packages/markdown/src" "$here/page.css"
npx @tailwindcss/cli -i input.css -o editor-bridge.css --minify

cp editor-bridge.js editor-bridge.css "$out/"
cp "$here/editor.html" "$out/editor.html"
ls -l "$out"
