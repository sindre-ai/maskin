import { describe, expect, it } from 'vitest'
import {
	VOICE_CONFIRM_ARG,
	createWriteGate,
	isNo,
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
		'I approve.',
		'Sounds good, send it.',
		'Sure, do that.',
		"Let's do it.",
		'Yes, send it.',
		'Approved.',
		'Yeah that works',
		'Yes, go ahead and send it now please',
		'Approve all',
	])('takes "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(true)
	})

	it.each([
		'no',
		'no wait',
		'yes but wait',
		'yes?',
		'can you repeat that',
		'yes please go ahead and do that right now with all of them',
		'yes but only Casper',
		'yes, send it to Casper instead',
		'sounds good, but wait',
		'what does it say',
		'perfect, can you read it first?',
		'yesterday',
		'not yet',
		"don't do it",
		'',
	])('does not take "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(false)
	})
})

describe('isNo', () => {
	it.each(['no', 'No, wait', "don't send it", 'not yet', 'cancel that', 'yes but change it'])(
		'takes "%s" for a no',
		(line) => {
			expect(isNo(line)).toBe(true)
		},
	)

	it.each(['what does it say', 'can you repeat that', 'hmm', 'read it again', 'yes'])(
		'does not take "%s" for a no',
		(line) => {
			expect(isNo(line)).toBe(false)
		},
	)
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
	const TOOL = 'gmail_send_email'
	const ARGS = { to: 'a@example.com', body: 'hi' }

	async function held() {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		const hold = await gate.review(TOOL, ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		return { gate, id: hold.id }
	}

	it('runs the write after a yes from speech that began after the hold', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_yes')
		gate.noteUserLine('yes', 'item_yes')
		expect(await gate.review(TOOL, ARGS, id)).toEqual({ kind: 'run' })
	})

	it('ignores a yes that carries no item id, since it cannot be placed after the hold', async () => {
		const { gate, id } = await held()
		gate.noteUserLine('yes', undefined)
		expect((await gate.review(TOOL, ARGS, id)).kind).toBe('refuse')
	})

	it('runs an ordinary workspace change at once, with no hold', async () => {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		expect(await gate.review('create_comment', { entity_id: 'e1' }, null)).toEqual({ kind: 'run' })
		expect(await gate.review('update_objects', { objects: [] }, null)).toEqual({ kind: 'run' })
	})

	it('still holds a send, a delete and a tool of an attached server', async () => {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		for (const tool of ['gmail_send_email', 'delete_object', 'gmail__send']) {
			expect((await gate.review(tool, {}, null)).kind).toBe('hold')
		}
	})

	it('runs the write after a natural yes such as "sounds good, send it"', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_yes')
		gate.noteUserLine('Sounds good, send it.', 'item_yes')
		expect(await gate.review(TOOL, ARGS, id)).toEqual({ kind: 'run' })
	})

	it('keeps the ask open through a question, then runs on the yes that follows', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_q')
		gate.noteUserLine('what does it say?', 'item_q')
		gate.noteSpeechStarted('item_yes')
		gate.noteUserLine('yes', 'item_yes')
		expect(await gate.review(TOOL, ARGS, id)).toEqual({ kind: 'run' })
	})

	it('turns the ask down on a clear no, and a repeat of the same hold stays refused', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_no')
		gate.noteUserLine("no, don't send it", 'item_no')
		expect(await gate.review(TOOL, ARGS, id)).toEqual({ kind: 'refuse', reason: 'declined' })
	})
})
