import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// The Tauri shell bundles apps/web's production Vite build (frontendDist in
// src-tauri/tauri.conf.json). This task exists so the root `pnpm build` stays
// green on machines without the Rust/Xcode toolchain — it only verifies the
// web build the shell consumes is present; the heavy compile is the opt-in
// `build:ios` task (tauri ios build) run on a Mac.
const webDist = resolve(import.meta.dirname, '../web/dist')

if (!existsSync(webDist)) {
	console.error(
		`@maskin/mobile: web production build not found at ${webDist}\n  The Tauri iOS shell bundles this directory into the app.\n  Run \`pnpm --filter @maskin/web build\` first (turbo does this via \`pnpm build\`).`,
	)
	process.exit(1)
}

console.log(`@maskin/mobile: web build present (${webDist}) — shell ready for tauri`)
