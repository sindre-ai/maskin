#!/usr/bin/env node
/**
 * CI gate for the rich-markdown-editor bet (`666e3c4a`, tech spec §12 rabbit
 * hole #6).
 *
 * `<MarkdownEditor>` (Tiptap, ~180 KB gzip) MUST be dynamic-imported so it
 * ships in its own code-split chunk — a static import from any read/marketing
 * path would collapse the Tiptap payload into the main entry chunk and bloat
 * every unauthenticated route by ~180 KB gzip. This script fails the build if
 * Tiptap / ProseMirror bytes end up in a chunk whose name identifies it as a
 * marketing / public / root / main entry rather than an on-demand editor
 * chunk. Wired into `apps/web`'s build via `package.json` so it runs after
 * `vite build`.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(__dirname, '..', 'dist', 'assets')

// Any chunk whose filename matches this must NOT contain Tiptap/ProseMirror.
// Vite's default naming stems from the module id of the entry/dynamic-import,
// so the main SPA bundle lands as `index-<hash>.js`. `marketing`/`public`/
// `root` are covered so an explicit manualChunks scheme (added later) is also
// gated.
const DANGER_CHUNK_RE = /^(index|main|marketing|public|root)[-.]/i

// Fingerprints that survive minification: `ProseMirror` is the CSS class the
// editor wrapper carries at runtime, and `@tiptap/pm` is a module id that
// preserves in un-minified output. Either indicates Tiptap payload.
const TIPTAP_FINGERPRINTS = ['ProseMirror', '@tiptap/pm']

async function listChunks() {
	try {
		const entries = await readdir(ASSETS_DIR, { withFileTypes: true })
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
			.map((entry) => entry.name)
	} catch (err) {
		if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
			throw new Error(
				`assert-editor-chunk: ${ASSETS_DIR} does not exist. Run \`vite build\` first.`,
			)
		}
		throw err
	}
}

function containsTiptap(source) {
	for (const marker of TIPTAP_FINGERPRINTS) {
		if (source.includes(marker)) return marker
	}
	return null
}

async function main() {
	const chunks = await listChunks()
	if (chunks.length === 0) {
		throw new Error(`assert-editor-chunk: no .js files found under ${ASSETS_DIR}.`)
	}

	const violations = []
	let sawTiptapAnywhere = false

	for (const name of chunks) {
		const source = await readFile(join(ASSETS_DIR, name), 'utf8')
		const marker = containsTiptap(source)
		if (!marker) continue
		sawTiptapAnywhere = true
		if (DANGER_CHUNK_RE.test(name)) {
			violations.push({ name, marker })
		}
	}

	if (violations.length > 0) {
		console.error(
			'\n[assert-editor-chunk] FAIL — Tiptap/ProseMirror leaked into a marketing/public/root chunk:',
		)
		for (const v of violations) {
			console.error(`  - ${v.name} contains "${v.marker}"`)
		}
		console.error(
			'\nThe MarkdownEditor MUST be dynamic-imported via `import()` (see',
			'`apps/web/src/components/shared/markdown-content.tsx`). A static import',
			'from a read/marketing path re-bundles Tiptap into the main entry chunk,',
			'ballooning unauthenticated route payloads by ~180 KB gzip.\n',
		)
		process.exit(1)
	}

	if (!sawTiptapAnywhere) {
		// A build that doesn't reach the editor path at all (e.g. tree-shaken
		// out because nothing imports @maskin/markdown/react/editor) is a
		// separate signal — not a failure of this gate, but worth noting.
		console.log('[assert-editor-chunk] OK — no Tiptap fingerprint found in any chunk.')
		return
	}

	console.log(
		'[assert-editor-chunk] OK — Tiptap is present only in code-split chunks, no marketing/public/root leak.',
	)
}

main().catch((err) => {
	console.error('[assert-editor-chunk] error:', err)
	process.exit(1)
})
