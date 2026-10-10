import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildOpenAPIDocument } from '../src/openapi'

const outPath = resolve(import.meta.dirname ?? __dirname, '../../../packages/sdk/openapi.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(buildOpenAPIDocument(), null, 2)}\n`)
console.log(`Wrote ${outPath}`)

// @maskin/mcp's server.ts runs `main()` at module load (its dual library/CLI
// shape), which attaches a StdioServerTransport listener and keeps the event
// loop alive. Exit explicitly so the script terminates promptly.
process.exit(0)
