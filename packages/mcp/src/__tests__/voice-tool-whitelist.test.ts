import { describe, expect, it } from 'vitest'
import {
	VOICE_ALLOWED_TOOLS,
	VOICE_CREATE_COMMENT_MAX_ATTENTION,
	VOICE_CREATE_OBJECTS_ALLOWED_TYPES,
	VOICE_READ_TOOLS,
	VOICE_TOOL_ERROR_CODES,
	VOICE_WRITE_TOOLS,
	VoiceToolNotAllowedError,
	assertVoiceCreateCommentAttentionAllowed,
	assertVoiceCreateObjectsTypesAllowed,
	assertVoiceInvocationAllowed,
	assertVoiceToolAllowed,
	isVoiceAllowedTool,
	isVoiceReadTool,
	isVoiceWriteTool,
} from '../voice-tool-whitelist'

describe('voice tool whitelist — set membership', () => {
	it('exposes the six read tools required by the spec', () => {
		expect([...VOICE_READ_TOOLS].sort()).toEqual(
			[
				'get_comments',
				'get_objects',
				'list_actors',
				'list_objects',
				'list_relationships',
				'search_objects',
			].sort(),
		)
	})

	it('exposes exactly two write tools — create_comment and create_objects', () => {
		expect([...VOICE_WRITE_TOOLS].sort()).toEqual(['create_comment', 'create_objects'])
	})

	it('has no overlap between read and write sets', () => {
		const overlap = VOICE_READ_TOOLS.filter((t) =>
			(VOICE_WRITE_TOOLS as readonly string[]).includes(t),
		)
		expect(overlap).toEqual([])
	})

	it('VOICE_ALLOWED_TOOLS is the union of read + write', () => {
		expect([...VOICE_ALLOWED_TOOLS].sort()).toEqual(
			[...VOICE_READ_TOOLS, ...VOICE_WRITE_TOOLS].sort(),
		)
	})

	it('type predicates match set membership', () => {
		expect(isVoiceReadTool('search_objects')).toBe(true)
		expect(isVoiceReadTool('create_comment')).toBe(false)
		expect(isVoiceWriteTool('create_comment')).toBe(true)
		expect(isVoiceWriteTool('search_objects')).toBe(false)
		expect(isVoiceAllowedTool('create_objects')).toBe(true)
		expect(isVoiceAllowedTool('delete_object')).toBe(false)
	})
})

describe('assertVoiceToolAllowed', () => {
	it('accepts every whitelisted tool without throwing', () => {
		for (const name of VOICE_ALLOWED_TOOLS) {
			expect(() => assertVoiceToolAllowed(name)).not.toThrow()
		}
	})

	it('rejects tools outside the whitelist with a tagged error', () => {
		try {
			assertVoiceToolAllowed('delete_object')
			throw new Error('expected assert to throw')
		} catch (err) {
			expect(err).toBeInstanceOf(VoiceToolNotAllowedError)
			expect((err as VoiceToolNotAllowedError).code).toBe(VOICE_TOOL_ERROR_CODES.toolNotAllowed)
			expect((err as VoiceToolNotAllowedError).message).toContain('delete_object')
		}
	})

	it('rejects other MCP tools that exist elsewhere but are not in scope for voice', () => {
		for (const name of ['create_loop', 'update_objects', 'update_workspace_skill']) {
			expect(() => assertVoiceToolAllowed(name)).toThrow(VoiceToolNotAllowedError)
		}
	})
})

describe('assertVoiceCreateCommentAttentionAllowed', () => {
	it('accepts attention values within cap', () => {
		for (const attention of [undefined, 1, 2, 3]) {
			expect(() =>
				assertVoiceCreateCommentAttentionAllowed({ entity_id: 'x', content: 'y', attention }),
			).not.toThrow()
		}
	})

	it('rejects attention 4 with the attentionTooHigh code', () => {
		try {
			assertVoiceCreateCommentAttentionAllowed({ attention: 4 })
			throw new Error('expected assert to throw')
		} catch (err) {
			expect(err).toBeInstanceOf(VoiceToolNotAllowedError)
			expect((err as VoiceToolNotAllowedError).code).toBe(VOICE_TOOL_ERROR_CODES.attentionTooHigh)
			expect((err as VoiceToolNotAllowedError).message).toContain('4')
		}
	})

	it('rejects attention 5', () => {
		expect(() => assertVoiceCreateCommentAttentionAllowed({ attention: 5 })).toThrow(
			VoiceToolNotAllowedError,
		)
	})

	it('is a no-op on malformed input (defers to schema validation)', () => {
		expect(() => assertVoiceCreateCommentAttentionAllowed(null)).not.toThrow()
		expect(() => assertVoiceCreateCommentAttentionAllowed('nope')).not.toThrow()
		expect(() => assertVoiceCreateCommentAttentionAllowed({ attention: '3' })).not.toThrow()
	})

	it('is aligned with the shared attention cap constant', () => {
		expect(VOICE_CREATE_COMMENT_MAX_ATTENTION).toBe(3)
	})
})

describe('assertVoiceCreateObjectsTypesAllowed', () => {
	it('accepts insight and task nodes, singly and mixed', () => {
		for (const type of VOICE_CREATE_OBJECTS_ALLOWED_TYPES) {
			expect(() =>
				assertVoiceCreateObjectsTypesAllowed({ nodes: [{ $id: 'a', type, title: 'x' }] }),
			).not.toThrow()
		}
		expect(() =>
			assertVoiceCreateObjectsTypesAllowed({
				nodes: [
					{ $id: 'a', type: 'insight' },
					{ $id: 'b', type: 'task' },
				],
			}),
		).not.toThrow()
	})

	it('rejects bet, meeting, knowledge, and every other non-allowed type', () => {
		for (const type of ['bet', 'meeting', 'knowledge', 'contact', 'agent']) {
			try {
				assertVoiceCreateObjectsTypesAllowed({ nodes: [{ $id: 'a', type }] })
				throw new Error(`expected type=${type} to be rejected`)
			} catch (err) {
				expect(err).toBeInstanceOf(VoiceToolNotAllowedError)
				expect((err as VoiceToolNotAllowedError).code).toBe(
					VOICE_TOOL_ERROR_CODES.createObjectsTypeNotAllowed,
				)
			}
		}
	})

	it('rejects on the first bad type inside a batch', () => {
		expect(() =>
			assertVoiceCreateObjectsTypesAllowed({
				nodes: [
					{ $id: 'a', type: 'insight', title: 'ok' },
					{ $id: 'b', type: 'bet', title: 'nope' },
				],
			}),
		).toThrow(VoiceToolNotAllowedError)
	})

	it('fails closed on a shape it cannot read', () => {
		// Regression: the first cut read `objects` / a top-level `type` and let
		// the real `nodes` shape through untouched.
		for (const args of [
			null,
			{},
			{ nodes: [] },
			{ nodes: 'bet' },
			{ nodes: [{ $id: 'a' }] },
			{ nodes: [{ $id: 'a', type: 123 }] },
			{ nodes: [null] },
			{ objects: [{ type: 'insight' }] },
			{ type: 'insight' },
		]) {
			expect(() => assertVoiceCreateObjectsTypesAllowed(args)).toThrow(VoiceToolNotAllowedError)
		}
	})
})

describe('assertVoiceInvocationAllowed — one-call gate', () => {
	it('accepts a plain read invocation', () => {
		expect(() =>
			assertVoiceInvocationAllowed('search_objects', { q: 'loops v4 bet' }),
		).not.toThrow()
	})

	it('accepts a well-formed create_comment', () => {
		expect(() =>
			assertVoiceInvocationAllowed('create_comment', {
				entity_id: '00000000-0000-0000-0000-000000000000',
				content: 'noted from voice call',
				attention: 2,
			}),
		).not.toThrow()
	})

	it('rejects create_comment with attention 5', () => {
		expect(() => assertVoiceInvocationAllowed('create_comment', { attention: 5 })).toThrow(
			VoiceToolNotAllowedError,
		)
	})

	it('rejects create_objects with a disallowed type', () => {
		expect(() =>
			assertVoiceInvocationAllowed('create_objects', { nodes: [{ $id: 'a', type: 'bet' }] }),
		).toThrow(VoiceToolNotAllowedError)
	})

	it('rejects tools outside the whitelist before evaluating args', () => {
		expect(() => assertVoiceInvocationAllowed('delete_object', {})).toThrow(
			VoiceToolNotAllowedError,
		)
	})
})
