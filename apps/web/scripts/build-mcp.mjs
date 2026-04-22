import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(__dirname, '..')
const outDir = resolve(webRoot, 'dist-mcp')
const tmpDir = resolve(webRoot, '.dist-mcp-tmp')

const apps = [
	'objects',
	'relationships',
	'actors',
	'workspaces',
	'events',
	'triggers',
	'graph',
	'generic',
]

// Clean output dirs
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const app of apps) {
	console.log(`\nBuilding MCP app: ${app}`)

	// Build to temp dir (vite outputs nested structure)
	rmSync(tmpDir, { recursive: true, force: true })
	execSync('npx vite build --config vite.config.mcp.ts', {
		stdio: 'inherit',
		cwd: webRoot,
		env: { ...process.env, MCP_APP: app },
	})

	// Copy the built HTML to flat output: dist-mcp/objects.html
	cpSync(resolve(tmpDir, `src/mcp-apps/${app}/index.html`), resolve(outDir, `${app}.html`))
}

// Clean up temp dir
rmSync(tmpDir, { recursive: true, force: true })

console.log(`\nAll ${apps.length} MCP apps built to ${outDir}`)
