import { build } from 'esbuild'

const banner = {
	js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
}

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	banner,
})

// Also bundled separately (not just tsc'd) so `dist/db/migrate.js` can run
// standalone in the production image without carrying dev-only deps like
// `tsx` into the runtime — see Dockerfile's CMD.
await build({
	entryPoints: ['src/db/migrate.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/db/migrate.js',
	sourcemap: true,
	banner,
})
