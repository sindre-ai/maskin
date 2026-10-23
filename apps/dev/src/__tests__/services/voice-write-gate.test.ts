import { describe, expect, it } from 'vitest'
import {
	VOICE_CONFIRM_ARG,
	createWriteGate,
	isRiskyTool,
	isYes,
	withConfirmationArg,
} from '../../services/voice-write-gate'

describe('isYes', () => {
	it.each([
		'yes',
		'Yes.',
		'yeah',
		'go ahead',
		'Do it!',
		'sure',
		'confirm',
		"That's right",
		'that is right',
		'yes, do it',
		'okay go ahead',
	])('takes "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(true)
	})

	it.each([
		'no',
		'no wait',
		'yes but wait',
		'yes?',
		'can you repeat that',
		'yes please go ahead and do that right now',
		'yesterday',
		'not yet',
		"don't do it",
		'',
	])('does not take "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(false)
	})
})

describe('isRiskyTool', () => {
	it.each([
		'gmail_send_email',
		'delete_object',
		'desktop_run',
		'update_actor',
		'gmail__send',
		'desktop_type',
		'update_workspace',
		'create_extension',
		'update_workspace_skill',
	])('puts %s in the risky class', (name) => {
		expect(isRiskyTool(name)).toBe(true)
	})

	it.each(['create_comment', 'update_objects', 'create_objects'])(
		'leaves %s as an ordinary write',
		(name) => {
			expect(isRiskyTool(name)).toBe(false)
		},
	)
})

describe('withConfirmationArg', () => {
	const tools = [
		{
			name: 'list_objects',
			parameters: { type: 'object', properties: { cursor: { type: 'string' } } },
		},
		{
			name: 'create_comment',
			parameters: { type: 'object', properties: { content: { type: 'string' } } },
		},
		{ name: 'ping', parameters: { type: 'object' } },
	]
	const out = withConfirmationArg(tools, new Set(['list_objects']))

	it('lists the repeat argument on a tool that can be held, next to its own', () => {
		const props = out[1].parameters.properties as Record<string, unknown>
		expect(Object.keys(props)).toEqual(['content', VOICE_CONFIRM_ARG])
	})

	it('adds it to a held tool that had no properties', () => {
		expect(Object.keys(out[2].parameters.properties as object)).toEqual([VOICE_CONFIRM_ARG])
	})

	it('leaves a read-only tool as it was', () => {
		expect(out[0]).toBe(tools[0])
	})
})

describe('createWriteGate', () => {
	const ARGS = { entity_id: 'e1', content: 'hi' }

	async function held() {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		const hold = await gate.review('create_comment', ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		return { gate, id: hold.id }
	}

	it('runs the write after a yes from speech that began after the hold', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_yes')
		gate.noteUserLine('yes', 'item_yes')
		expect(await gate.review('create_comment', ARGS, id)).toEqual({ kind: 'run' })
	})

	it('ignores a yes that carries no item id, since it cannot be placed after the hold', async () => {
		const { gate, id } = await held()
		gate.noteUserLine('yes', undefined)
		expect((await gate.review('create_comment', ARGS, id)).kind).toBe('refuse')
	})
})
