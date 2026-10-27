import { describe, expect, it, vi } from 'vitest'
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
		"That's right",
		'that is right',
		'yes, do it',
		'okay go ahead',
		'I approve.',
		'great, send it',
		'perfect',
		'okay sure',
		'confirmed',
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
		'go',
		'okay go',
		'lets go',
		'send 500',
		'send $500',
		'approve 2',
		'approve #3',
		'go 2',
		'send it 5',
		'do it 10',
		'send 2 please',
		'go ahead 3',
		'yes 5',
		'yes åbn den',
		'send ø',
		'yes 👍',
		'approve 50%',
		'please correct',
		'okay correct',
		'please confirm',
		'okay confirm',
		'confirm',
		'correct',
		'please',
		'please now',
		'fine',
		'great',
		'alright',
		'exactly',
		'please correct it',
		'ok correct that',
		'okay confirm it',
		'okay is that right',
		'sure is that correct',
		'okay is it fine',
		'yes do you',
		'sure you do it',
		'ok you send it',
		'please read it to me first',
		'sure, what does it say',
		'ok so who gets it',
		'great, read me the draft',
		'go ahead and read it',
		'okay show me the email',
		'right now',
		'yes send it to Casper',
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

describe('isYes in Danish', () => {
	it.each([
		'ja',
		'Ja.',
		'ja tak',
		'jo',
		'selvfølgelig',
		'jep',
		'perfekt',
		'send den',
		'ja, send den',
		'send det afsted',
		'send den bare',
		'send den gerne',
		'godkend',
		'godkend alle',
		'ja, godkend alle',
		'godkendt',
		'jeg godkender',
		'det lyder godt',
		'ja, det lyder godt, send den',
		'det ser fint ud',
		'det er i orden',
		'det er fint',
		'det passer',
		'gør det',
		'ja, gør det nu',
		'kør på',
		'sæt i gang',
		'lad os gøre det',
		'helt sikkert',
		'gerne',
		'ja gerne',
		'fint, send den',
		'ja og send den',
		'ja, send den, og godkend alle',
	])('takes "%s" for a yes', (line) => {
		expect(isYes(line)).toBe(true)
	})

	it.each([
		'nej',
		'nej tak',
		'ikke endnu',
		'vent lidt',
		'ja men vent',
		'ja men kun til Casper',
		'ja, send den ikke',
		'ja, hvad står der?',
		'hvad står der',
		'ja, læs den højt',
		'læs den højt',
		'vis mig mailen',
		'ja, vis mig den først',
		'send den til Casper',
		'ja send 500',
		'godkend 2',
		'ja 5',
		'ja, kan du sende den',
		'kan du læse den igen',
		'fint',
		'godt',
		'super',
		'ja, rediger den først',
		'ja, ændre den',
		'ja, send den senere',
		'ja é',
		'ja ü',
		'ja 👍',
		'gør det ikke',
		'det er ikke fint',
		'jeg ved det ikke',
		'send',
	])('does not take "%s" for a yes', (line) => {
		// 'send' alone is an English approval phrase and stays a yes; it is listed in the
		// accepted English tests. The line below keeps this table honest about that.
		expect(isYes(line)).toBe(line === 'send')
	})

	it('still takes a Danish and English mix', () => {
		expect(isYes('ja, send it')).toBe(true)
		expect(isYes('yes, send den')).toBe(true)
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

describe('createWriteGate — the yes is tied to the text that was asked about', () => {
	const TOOL = 'gmail_send_email'
	const ARGS = { object_id: 'obj-1' }
	const preview = (fingerprint: string, body = 'Hello') => ({
		summary: 'Send this email',
		recipients: ['Lars <lars@example.com>'],
		subject: 'Meeting',
		body,
		note: null,
		fingerprint,
	})

	/** A target whose text can be changed between the hold and the repeat. */
	function target(initial: string) {
		let fingerprint = initial
		const previewFor = vi.fn(async () => preview(fingerprint, `text ${fingerprint}`))
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const edit = (next: string) => {
			fingerprint = next
		}
		return { gate, previewFor, edit }
	}
	const say = (gate: ReturnType<typeof createWriteGate>, item: string) => {
		gate.noteSpeechStarted(item)
		gate.noteUserLine('yes', item)
	}

	it('returns the preview of the target with the hold', async () => {
		const { gate } = target('v1')
		const hold = await gate.review(TOOL, ARGS, null)
		expect(hold).toMatchObject({
			kind: 'hold',
			changed: false,
			preview: { subject: 'Meeting', body: 'text v1' },
		})
	})

	it('runs when the target is unchanged since the hold', async () => {
		const { gate } = target('v1')
		const hold = await gate.review(TOOL, ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		expect(await gate.review(TOOL, ARGS, hold.id)).toEqual({ kind: 'run' })
	})

	it('does not run on a yes for old text: the same arguments and id give a new hold with the new text', async () => {
		const { gate, edit } = target('v1')
		const hold = await gate.review(TOOL, ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		edit('v2')
		const again = await gate.review(TOOL, ARGS, hold.id)
		expect(again).toMatchObject({
			kind: 'hold',
			changed: true,
			preview: { body: 'text v2' },
		})
		if (again.kind !== 'hold') throw new Error('expected a hold')
		expect(again.id).not.toBe(hold.id)
		// The old id is dead, and the new hold still needs its own yes.
		expect((await gate.review(TOOL, ARGS, hold.id)).kind).toBe('hold')
		const latest = await gate.review(TOOL, ARGS, null)
		if (latest.kind !== 'hold') throw new Error('expected a hold')
		expect((await gate.review(TOOL, ARGS, latest.id)).kind).toBe('refuse')
	})

	it('runs after a fresh yes to the new hold', async () => {
		const { gate, edit } = target('v1')
		const hold = await gate.review(TOOL, ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		edit('v2')
		const again = await gate.review(TOOL, ARGS, hold.id)
		if (again.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes_2')
		expect(await gate.review(TOOL, ARGS, again.id)).toEqual({ kind: 'run' })
	})

	it('works the fingerprint out from the target again each time and never takes it from the model', async () => {
		const { gate, previewFor } = target('v1')
		const hold = await gate.review(TOOL, { ...ARGS, fingerprint: 'v1' }, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		await gate.review(TOOL, { ...ARGS, fingerprint: 'v1' }, hold.id)
		// Once for the hold, once more for the repeat.
		expect(previewFor).toHaveBeenCalledTimes(2)
	})

	it('still holds, with no preview, when the lookup fails, and then runs on a yes', async () => {
		const previewFor = vi.fn().mockRejectedValue(new Error('db down'))
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const hold = await gate.review(TOOL, ARGS, null)
		expect(hold).toMatchObject({ kind: 'hold', preview: null })
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		expect(await gate.review(TOOL, ARGS, hold.id)).toEqual({ kind: 'run' })
	})

	it('treats a lookup that failed at the hold but works at the repeat as changed text', async () => {
		const previewFor = vi
			.fn()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValue(preview('v1'))
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const hold = await gate.review(TOOL, ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say(gate, 'item_yes')
		expect(await gate.review(TOOL, ARGS, hold.id)).toMatchObject({ kind: 'hold', changed: true })
	})
})
