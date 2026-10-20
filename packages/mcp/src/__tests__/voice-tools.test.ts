import { describe, expect, it } from 'vitest'
import type { ZodObject, ZodRawShape } from 'zod'
import { tools } from '../tools'
import {
	VOICE_ALLOWED_TOOLS,
	VOICE_TOOL_ERROR_CODES,
	type VoiceToolNotAllowedError,
} from '../voice-tool-whitelist'
import { VOICE_REALTIME_TOOLS, parseVoiceToolArgs } from '../voice-tools'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '22222222-2222-4222-8222-222222222222'
const ID = '33333333-3333-4333-8333-333333333333'

function shapeOf(name: string): ZodRawShape {
	return (tools as unknown as Record<string, { inputSchema: ZodObject<ZodRawShape> }>)[name]
		.inputSchema.shape
}

describe('VOICE_REALTIME_TOOLS — what session-mint pins', () => {
	it('advertises exactly the whitelisted tools, once each', () => {
		expect(VOICE_REALTIME_TOOLS.map((t) => t.name).sort()).toEqual([...VOICE_ALLOWED_TOOLS].sort())
	})

	it('only advertises fields the real MCP input schema accepts (drift check)', () => {
		for (const tool of VOICE_REALTIME_TOOLS) {
			const real = Object.keys(shapeOf(tool.name))
			for (const prop of Object.keys(tool.parameters.properties)) {
				expect(real, `${tool.name}.${prop}`).toContain(prop)
			}
			expect(real).toContain('workspace_id')
			// workspace_id is forced server-side, so the model must not be asked for it.
			expect(Object.keys(tool.parameters.properties)).not.toContain('workspace_id')
		}
	})

	it('never advertises a create_objects type outside insight and task', () => {
		const create = VOICE_REALTIME_TOOLS.find((t) => t.name === 'create_objects')
		const nodes = create?.parameters.properties.nodes as {
			items: { properties: { type: { enum: string[] } } }
		}
		expect(nodes.items.properties.type.enum.sort()).toEqual(['insight', 'task'])
	})

	it('caps the advertised comment attention at 3', () => {
		const create = VOICE_REALTIME_TOOLS.find((t) => t.name === 'create_comment')
		expect(create?.parameters.properties.attention).toMatchObject({ maximum: 3 })
	})
})

describe('parseVoiceToolArgs', () => {
	it('forces workspace_id to the session workspace, ignoring a model-supplied one', () => {
		const parsed = parseVoiceToolArgs(
			'search_objects',
			{ q: 'loops v4', workspace_id: OTHER_WS },
			WS,
		)
		expect(parsed.workspace_id).toBe(WS)
		expect(parsed.q).toBe('loops v4')
	})

	it('fills workspace_id for tools whose schema requires it', () => {
		expect(parseVoiceToolArgs('list_objects', { type: 'task' }, WS).workspace_id).toBe(WS)
	})

	it('applies the real schema defaults (invokeTool skips SDK parsing)', () => {
		expect(parseVoiceToolArgs('get_objects', { ids: [ID] }, WS).include).toEqual([])
	})

	it('rejects a tool off the whitelist with the not-allowed code', () => {
		try {
			parseVoiceToolArgs('delete_object', { id: ID }, WS)
			throw new Error('expected throw')
		} catch (err) {
			expect((err as VoiceToolNotAllowedError).code).toBe(VOICE_TOOL_ERROR_CODES.toolNotAllowed)
		}
	})

	it('rejects create_comment attention 4 and 5 with the attention code, accepts 3', () => {
		for (const attention of [4, 5]) {
			try {
				parseVoiceToolArgs('create_comment', { entity_id: ID, content: 'hi', attention }, WS)
				throw new Error('expected throw')
			} catch (err) {
				expect((err as VoiceToolNotAllowedError).code).toBe(VOICE_TOOL_ERROR_CODES.attentionTooHigh)
			}
		}
		expect(
			parseVoiceToolArgs('create_comment', { entity_id: ID, content: 'hi', attention: 3 }, WS)
				.attention,
		).toBe(3)
	})

	it('rejects create_objects of a bet, accepts an insight and a task', () => {
		const node = (type: string) => ({
			nodes: [{ $id: 'n1', type, title: 'x', status: type === 'task' ? 'backlog' : 'new' }],
		})
		try {
			parseVoiceToolArgs('create_objects', node('bet'), WS)
			throw new Error('expected throw')
		} catch (err) {
			expect((err as VoiceToolNotAllowedError).code).toBe(
				VOICE_TOOL_ERROR_CODES.createObjectsTypeNotAllowed,
			)
		}
		expect(() => parseVoiceToolArgs('create_objects', node('insight'), WS)).not.toThrow()
		expect(() => parseVoiceToolArgs('create_objects', node('task'), WS)).not.toThrow()
	})

	it('rejects malformed args with the invalid-arguments code', () => {
		for (const args of [null, 'x', [], { q: '' }, { q: 42 }]) {
			try {
				parseVoiceToolArgs('search_objects', args, WS)
				throw new Error('expected throw')
			} catch (err) {
				expect((err as VoiceToolNotAllowedError).code).toBe(VOICE_TOOL_ERROR_CODES.invalidArguments)
			}
		}
	})
})
