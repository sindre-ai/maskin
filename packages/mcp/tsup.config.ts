import { defineConfig } from 'tsup'

export default defineConfig([
	{
		entry: { index: 'src/index.ts' },
		format: ['esm'],
		target: 'node20',
		dts: true,
		clean: true,
		sourcemap: true,
		// Inline workspace-only deps so the published package has no @maskin/* runtime deps.
		// Standard npm deps (@modelcontextprotocol/*, zod) stay external — npm resolves them.
		noExternal: [/^@maskin\//],
	},
	{
		entry: { cli: 'src/cli.ts' },
		format: ['esm'],
		target: 'node20',
		clean: false,
		sourcemap: true,
		noExternal: [/^@maskin\//],
		banner: { js: '#!/usr/bin/env node' },
	},
])
