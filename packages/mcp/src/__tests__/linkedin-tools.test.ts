import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tools } from '../tools'

/**
 * Schema tests for the three LinkedIn (Unipile-backed) MCP tools. Two
 * invariants get asserted for every field:
 *   1. every input field carries a non-empty `.describe()` — agents lean
 *      on the description to pick call args, so a bare field is a bug the
 *      first user of the tool will hit;
 *   2. min/max constraints match the parent-bet spec §1 (recipient_urn
 *      length, body max 8000, idempotency_key max 128, list pagination
 *      cursor + 1..50 limit).
 * Together these prevent silent drift when a future refactor renames or
 * loosens a field.
 */

const LINKEDIN_TOOLS = ['linkedin__send_message', 'linkedin__list_conversations', 'linkedin__reply'] as const

function assertAllFieldsDescribed(schema: z.ZodTypeAny): { field: string; described: boolean }[] {
	if (!(schema instanceof z.ZodObject)) return []
	const shape = schema.shape as Record<string, z.ZodTypeAny>
	const results: { field: string; described: boolean }[] = []
	for (const [field, sub] of Object.entries(shape)) {
		const description = extractDescription(sub)
		results.push({ field, described: typeof description === 'string' && description.length > 0 })
	}
	return results
}

function extractDescription(schema: z.ZodTypeAny): string | undefined {
	const anyDef = (schema as unknown as { _def: { description?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def
	if (anyDef.description) return anyDef.description
	if (anyDef.innerType) return extractDescription(anyDef.innerType)
	if (anyDef.schema) return extractDescription(anyDef.schema)
	return undefined
}

describe('LinkedIn MCP tool registration', () => {
	for (const name of LINKEDIN_TOOLS) {
		it(`exports ${name}`, () => {
			expect(tools).toHaveProperty(name)
			const tool = (tools as unknown as Record<string, unknown>)[name]
			expect(tool).toBeDefined()
			expect(typeof (tool as { description?: string }).description).toBe('string')
			expect((tool as { description: string }).description.length).toBeGreaterThan(20)
		})

		it(`${name}: every input field has .describe()`, () => {
			const tool = (tools as unknown as Record<string, { inputSchema: z.ZodObject<z.ZodRawShape> }>)[name]
			const audit = assertAllFieldsDescribed(tool.inputSchema)
			const undocumented = audit.filter((row) => !row.described).map((r) => r.field)
			expect(undocumented, `Undocumented fields on ${name}: ${undocumented.join(', ')}`).toEqual([])
		})
	}
})

describe('linkedin__send_message input schema', () => {
	const schema = tools.linkedin__send_message.inputSchema

	it('accepts a valid payload', () => {
		const parsed = schema.safeParse({
			workspace_id: '11111111-1111-1111-1111-111111111111',
			recipient_urn: 'urn:li:person:AbC123',
			body: 'Hello',
			idempotency_key: 'contact-42:draft-7',
		})
		expect(parsed.success).toBe(true)
	})

	it('rejects an empty body', () => {
		const parsed = schema.safeParse({
			recipient_urn: 'urn:li:person:AbC123',
			body: '',
			idempotency_key: 'k',
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects a body over the 8000-char limit', () => {
		const parsed = schema.safeParse({
			recipient_urn: 'urn:li:person:AbC123',
			body: 'a'.repeat(8001),
			idempotency_key: 'k',
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects a missing recipient_urn', () => {
		const parsed = schema.safeParse({ body: 'hi', idempotency_key: 'k' })
		expect(parsed.success).toBe(false)
	})

	it('rejects an idempotency_key over 128 chars', () => {
		const parsed = schema.safeParse({
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'x'.repeat(129),
		})
		expect(parsed.success).toBe(false)
	})

	it('makes workspace_id optional', () => {
		const parsed = schema.safeParse({
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k',
		})
		expect(parsed.success).toBe(true)
	})
})

describe('linkedin__reply input schema', () => {
	const schema = tools.linkedin__reply.inputSchema

	it('accepts a valid payload', () => {
		const parsed = schema.safeParse({
			thread_id: 'thread-1',
			body: 'thanks!',
			idempotency_key: 'thread-1:draft-1',
		})
		expect(parsed.success).toBe(true)
	})

	it('rejects a missing thread_id', () => {
		const parsed = schema.safeParse({ body: 'hi', idempotency_key: 'k' })
		expect(parsed.success).toBe(false)
	})
})

describe('linkedin__list_conversations input schema', () => {
	const schema = tools.linkedin__list_conversations.inputSchema

	it('defaults limit to 25', () => {
		const parsed = schema.parse({})
		expect(parsed.limit).toBe(25)
	})

	it('rejects limit > 50', () => {
		const parsed = schema.safeParse({ limit: 51 })
		expect(parsed.success).toBe(false)
	})

	it('rejects limit < 1', () => {
		const parsed = schema.safeParse({ limit: 0 })
		expect(parsed.success).toBe(false)
	})

	it('accepts a cursor', () => {
		const parsed = schema.parse({ cursor: 'opaque-cursor' })
		expect(parsed.cursor).toBe('opaque-cursor')
	})
})
