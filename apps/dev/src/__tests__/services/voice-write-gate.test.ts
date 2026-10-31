import { createVoiceToolkit } from '@maskin/mcp'
import { describe, expect, it, vi } from 'vitest'
import {
	ORDINARY_WRITE_TOOLS,
	VOICE_CONFIRM_ARG,
	createWriteGate,
	isHeldWhenDelegated,
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
		expect(await gate.review(TOOL, ARGS, id)).toMatchObject({ kind: 'run' })
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
		expect(await gate.review(TOOL, ARGS, id)).toMatchObject({ kind: 'run' })
	})

	it('keeps the ask open through a question, then runs on the yes that follows', async () => {
		const { gate, id } = await held()
		gate.noteSpeechStarted('item_q')
		gate.noteUserLine('what does it say?', 'item_q')
		gate.noteSpeechStarted('item_yes')
		gate.noteUserLine('yes', 'item_yes')
		expect(await gate.review(TOOL, ARGS, id)).toMatchObject({ kind: 'run' })
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
		expect(await gate.review(TOOL, ARGS, hold.id)).toMatchObject({ kind: 'run' })
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
		expect(await gate.review(TOOL, ARGS, again.id)).toMatchObject({ kind: 'run' })
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
		expect(await gate.review(TOOL, ARGS, hold.id)).toMatchObject({ kind: 'run' })
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

describe('createWriteGate: what the call receipt reads from the gate', () => {
	const TOOL = 'gmail_send_email'
	const ARGS = { object_id: 'obj-1' }

	function target(initial: string) {
		let current = initial
		const previewFor = vi.fn(async () => ({
			summary: 'Send this email',
			recipients: ['Lars <lars@example.dk>'],
			subject: 'Meeting',
			body: `text ${current}`,
			note: null,
			fingerprint: `fp-${current}`,
		}))
		return {
			previewFor,
			edit: (next: string) => {
				current = next
			},
		}
	}
	const say = (gate: ReturnType<typeof createWriteGate>, item: string, line = 'yes') => {
		gate.noteSpeechStarted(item)
		gate.noteUserLine(line, item)
	}
	async function hold(
		gate: ReturnType<typeof createWriteGate>,
		tool = TOOL,
		id: string | null = null,
	) {
		const review = await gate.review(tool, ARGS, id)
		if (review.kind !== 'hold') throw new Error('expected a hold')
		return review
	}

	it('reports one yes and a matching read-back for a send that went through', async () => {
		const { previewFor } = target('v1')
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const first = await hold(gate)
		say(gate, 'item_1')
		const run = await gate.review(TOOL, ARGS, first.id)
		expect(run).toEqual({
			kind: 'run',
			confirmed: { holdId: first.id, yesCount: 1, readBackMatches: true },
		})
	})

	it('counts two yeses when the text changed after the first one', async () => {
		const { previewFor, edit } = target('v1')
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const first = await hold(gate)
		say(gate, 'item_1')
		edit('v2')
		const second = await hold(gate, TOOL, first.id)
		say(gate, 'item_2')
		const run = await gate.review(TOOL, ARGS, second.id)
		expect(run).toMatchObject({ kind: 'run', confirmed: { yesCount: 2, readBackMatches: true } })
	})

	it('starts the yes count again for a different send', async () => {
		const { previewFor } = target('v1')
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		const first = await hold(gate)
		say(gate, 'item_1')
		await gate.review(TOOL, ARGS, first.id)
		const other = await hold(gate, 'post_conversation_message')
		say(gate, 'item_2')
		expect(await gate.review('post_conversation_message', ARGS, other.id)).toMatchObject({
			confirmed: { yesCount: 1 },
		})
	})

	it('says the read-back is unknown when no preview could be made', async () => {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		const first = await hold(gate)
		say(gate, 'item_1')
		expect(await gate.review(TOOL, ARGS, first.id)).toMatchObject({
			kind: 'run',
			confirmed: { yesCount: 1, readBackMatches: null },
		})
	})

	it('tells the listener about a hold the person turned down', async () => {
		const ended = vi.fn()
		const { previewFor } = target('v1')
		const gate = createWriteGate({
			voiceSessionId: 's1',
			isReadOnlyTool: () => false,
			previewFor,
			onHoldEnded: ended,
		})
		const first = await hold(gate)
		say(gate, 'item_1', 'no, wait')
		expect(ended).toHaveBeenCalledTimes(1)
		expect(ended).toHaveBeenCalledWith(
			expect.objectContaining({
				id: first.id,
				tool: TOOL,
				state: 'declined',
				summary: 'Send this email',
				yesCount: 0,
			}),
		)
	})

	it('tells the listener once about a hold that timed out', async () => {
		vi.useFakeTimers()
		try {
			const ended = vi.fn()
			const { previewFor } = target('v1')
			const gate = createWriteGate({
				voiceSessionId: 's1',
				isReadOnlyTool: () => false,
				previewFor,
				onHoldEnded: ended,
			})
			await hold(gate)
			vi.advanceTimersByTime(60_000)
			vi.advanceTimersByTime(60_000)
			expect(ended).toHaveBeenCalledTimes(1)
			expect(ended.mock.calls[0]?.[0]).toMatchObject({ state: 'expired' })
			expect(gate.pendingHold()).toBeNull()
		} finally {
			vi.useRealTimers()
		}
	})

	it('names the tool that replaced a hold, so the same send asked again can be told apart', async () => {
		const ended = vi.fn()
		const { previewFor, edit } = target('v1')
		const gate = createWriteGate({
			voiceSessionId: 's1',
			isReadOnlyTool: () => false,
			previewFor,
			onHoldEnded: ended,
		})
		const first = await hold(gate)
		say(gate, 'item_1')
		edit('v2')
		await hold(gate, TOOL, first.id)
		expect(ended.mock.calls[0]?.[0]).toMatchObject({
			state: 'superseded',
			replacedByTool: TOOL,
			yesCount: 1,
		})
		await hold(gate, 'post_conversation_message')
		expect(ended.mock.calls[1]?.[0]).toMatchObject({
			state: 'superseded',
			tool: TOOL,
			replacedByTool: 'post_conversation_message',
		})
	})

	it('carries the held arguments, and the replacing calls, so a different send can be told apart', async () => {
		const ended = vi.fn()
		const { previewFor } = target('v1')
		const gate = createWriteGate({
			voiceSessionId: 's1',
			isReadOnlyTool: () => false,
			previewFor,
			onHoldEnded: ended,
		})
		await gate.review(TOOL, { ...ARGS, to: 'anna' }, null)
		await gate.review(TOOL, { ...ARGS, to: 'lars' }, null)
		const end = ended.mock.calls[0]?.[0]
		expect(end).toMatchObject({ state: 'superseded', replacedByTool: TOOL })
		expect(end.argsKey).toEqual(expect.any(String))
		expect(end.replacedByArgsKey).toEqual(expect.any(String))
		expect(end.replacedByArgsKey).not.toBe(end.argsKey)
		// The same arguments asked again give the same key on both sides.
		await gate.review(TOOL, { ...ARGS, to: 'lars' }, null)
		const again = ended.mock.calls[1]?.[0]
		expect(again.replacedByArgsKey).toBe(again.argsKey)
	})

	it('does not tell the listener about a hold that ran', async () => {
		const ended = vi.fn()
		const { previewFor } = target('v1')
		const gate = createWriteGate({
			voiceSessionId: 's1',
			isReadOnlyTool: () => false,
			previewFor,
			onHoldEnded: ended,
		})
		const first = await hold(gate)
		say(gate, 'item_1')
		await gate.review(TOOL, ARGS, first.id)
		expect(ended).not.toHaveBeenCalled()
	})

	it('exposes the hold still waiting for a yes, and nothing once it is settled', async () => {
		const { previewFor } = target('v1')
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false, previewFor })
		expect(gate.pendingHold()).toBeNull()
		const first = await hold(gate)
		expect(gate.pendingHold()).toEqual({ tool: TOOL, summary: 'Send this email', yesCount: 0 })
		say(gate, 'item_1')
		await gate.review(TOOL, ARGS, first.id)
		expect(gate.pendingHold()).toBeNull()
	})
})

describe('createWriteGate: a decision write needs a clear yes', () => {
	const ARGS = { entity_id: 'card-1', content: 'go' }
	const make = () =>
		createWriteGate({
			voiceSessionId: 's1',
			isReadOnlyTool: () => false,
			isDecisionWrite: (tool, args) =>
				tool === 'create_comment' && (args as { entity_id?: string }).entity_id === 'card-1',
		})

	it('holds a decision write and flags it as a decision, but not other comments', async () => {
		const gate = make()
		expect(await gate.review('create_comment', ARGS, null)).toMatchObject({
			kind: 'hold',
			decision: true,
			risky: false,
		})
		expect(await gate.review('create_comment', { entity_id: 'other' }, null)).toEqual({
			kind: 'run',
		})
	})

	it.each(['mm', 'Mm.', 'mhm', 'go on', 'okay go on', 'right'])(
		'does not take "%s" for the yes',
		async (line) => {
			vi.useFakeTimers()
			const gate = make()
			const hold = await gate.review('create_comment', ARGS, null)
			if (hold.kind !== 'hold') throw new Error('expected a hold')
			gate.noteSpeechStarted('i1')
			gate.noteUserLine(line, 'i1')
			const result = gate.review('create_comment', ARGS, hold.id)
			await vi.advanceTimersByTimeAsync(4_000)
			expect(await result).toEqual({ kind: 'refuse', reason: 'no_yes' })
			vi.useRealTimers()
		},
	)

	it('runs after a clear yes spoken after the hold', async () => {
		const gate = make()
		const hold = await gate.review('create_comment', ARGS, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		gate.noteSpeechStarted('i1')
		gate.noteUserLine('yes', 'i1')
		expect(await gate.review('create_comment', ARGS, hold.id)).toMatchObject({ kind: 'run' })
	})
})

describe('every tool of the real toolkit has a write-gate decision', () => {
	/**
	 * Writes that run at once on a DIRECT call and are not on the ordinary-write allow-list, so a
	 * call made through ask_workspace holds them. A tool added to the toolkit must be placed in
	 * exactly one of: read-only, ORDINARY_WRITE_TOOLS, the risky class (voice-write-gate.ts), or
	 * this list. A new tool that is in none of them fails here.
	 */
	const DIRECT_ONLY_WRITES = new Set([
		'add_chat_participant',
		'ask_user_question',
		'create_chat',
		'create_file',
		'create_sub_chat',
		'create_workspace',
		'create_workspace_field',
		'desktop_close_port',
		'desktop_move',
		'desktop_screenshot',
		'desktop_scroll',
		'get_started',
		'pause_session',
		'remove_chat_participant',
		'show_computer',
		'stop_chat_agent',
		'update_file',
		'update_notification',
		'update_workspace_field',
	])

	it('puts each tool in exactly one class', async () => {
		const { tools, readOnlyTools, close } = await createVoiceToolkit({
			apiBaseUrl: 'http://localhost:0',
			apiKey: 'test',
			defaultWorkspaceId: '00000000-0000-4000-8000-000000000000',
		})
		await close()
		const undecided: string[] = []
		const several: string[] = []
		for (const { name } of tools) {
			const classes = [
				readOnlyTools.has(name),
				ORDINARY_WRITE_TOOLS.has(name),
				isRiskyTool(name),
				DIRECT_ONLY_WRITES.has(name),
			].filter(Boolean).length
			if (classes === 0) undecided.push(name)
			if (classes > 1) several.push(name)
		}
		expect(undecided).toEqual([])
		expect(several).toEqual([])
	})

	it('holds every write a delegated call makes unless it is an ordinary write', async () => {
		const { tools, readOnlyTools, close } = await createVoiceToolkit({
			apiBaseUrl: 'http://localhost:0',
			apiKey: 'test',
			defaultWorkspaceId: '00000000-0000-4000-8000-000000000000',
		})
		await close()
		for (const { name } of tools) {
			const expected = !readOnlyTools.has(name) && !ORDINARY_WRITE_TOOLS.has(name)
			expect(isHeldWhenDelegated(name, readOnlyTools.has(name)), name).toBe(expected)
		}
	})

	it('holds an alias exactly as it holds the tool it points to', () => {
		expect(isRiskyTool('run_agent')).toBe(isRiskyTool('create_session'))
		expect(isRiskyTool('run_agent')).toBe(true)
		expect(isRiskyTool('resend_send_email')).toBe(true)
	})

	it('holds an unknown write when it is delegated but runs it when called directly', async () => {
		const gate = createWriteGate({ voiceSessionId: 's1', isReadOnlyTool: () => false })
		expect(await gate.review('brand_new_tool', {}, null)).toMatchObject({ kind: 'run' })
		expect(await gate.review('brand_new_tool', {}, null, { delegated: true })).toMatchObject({
			kind: 'hold',
			risky: true,
		})
		expect(await gate.review('create_comment', {}, null, { delegated: true })).toMatchObject({
			kind: 'run',
		})
	})
})
