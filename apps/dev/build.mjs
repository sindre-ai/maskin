import { build } from 'esbuild'

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: 'dist/index.js',
	sourcemap: true,
	// Externalize packages with native bindings that can't be bundled.
	// `jsdom` isn't native but its runtime uses dynamic `require()` (for canvas
	// and other optional deps) that esbuild can't statically resolve; keeping
	// it external preserves its own module resolution at runtime.
	external: ['dockerode', 'postgres', 'bcryptjs', 'cpu-features', 'ssh2', 'jsdom'],
	banner: {
		js: "import { createRequire as __createBannerRequire } from 'module'; const require = __createBannerRequire(import.meta.url);",
	},
})
