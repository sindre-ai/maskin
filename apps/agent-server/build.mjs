import { build } from 'esbuild'

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	external: ['dockerode', 'postgres', 'microsandbox', 'cpu-features', 'ssh2', 'tar-stream'],
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
})
