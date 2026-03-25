import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// vite-plugin-singlefile requires a single input (inlineDynamicImports).
// The build:mcp script calls this config once per app via MCP_APP env var.
const app = process.env.MCP_APP

if (!app) {
	throw new Error(
		'MCP_APP env var is required. Use the build:mcp script instead of calling vite directly.',
	)
}

export default defineConfig({
	plugins: [react(), tailwindcss(), viteSingleFile()],
	resolve: {
		alias: {
			'@': '/src',
		},
	},
	build: {
		outDir: '.dist-mcp-tmp',
		emptyOutDir: true,
		rollupOptions: {
			input: `src/mcp-apps/${app}/index.html`,
		},
	},
})
