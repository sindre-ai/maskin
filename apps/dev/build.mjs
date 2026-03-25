import { build } from 'esbuild'

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	// Only externalize packages with native bindings that can't be bundled
	external: ['dockerode', 'postgres', 'bcryptjs', 'cpu-features', 'ssh2'],
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
})
