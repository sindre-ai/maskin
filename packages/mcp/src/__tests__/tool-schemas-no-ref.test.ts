import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { tools } from '../tools'

// The Claude CLI hands every tool's input schema to the model provider. Some
// providers (DigitalOcean on OpenRouter) turn each schema into a decoding
// grammar and reject a `$ref` with a 400 "Invalid structural tag
// specification", which fails every request that carries the tool.
// zod-to-json-schema emits a `$ref` whenever one schema *instance* appears
// twice in the same tool — e.g. a shared `const jsonPrimitive` used in two
// places — so the reuse has to be a fresh instance (a function), not a shared
// constant.
describe('MCP tool input schemas', () => {
	it.each(Object.entries(tools))('%s has no $ref in its JSON schema', (_name, tool) => {
		const schema = toJsonSchemaCompat(tool.inputSchema as z.ZodTypeAny, {
			strictUnions: true,
			pipeStrategy: 'input',
		})
		expect(JSON.stringify(schema)).not.toContain('"$ref"')
	})
})
