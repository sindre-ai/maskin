import type { Database } from '@maskin/db'
import { MESSAGE_MAX_LENGTH } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { buildObjectPreview } from '../../lib/object-preview'
import {
	type HoldPreview,
	VOICE_HOLD_BODY_MAX_CHARS,
	VOICE_READ_ALOUD_MAX_CHARS,
	buildHoldPreview,
	formatHoldPreviewForChat,
	formatHoldPreviewForModel,
	readAloudInstruction,
	readAloudLength,
	spokenEdges,
} from '../../services/voice-hold-preview'

const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const OBJECT_ID = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'

/** Each select() answers with the next queued rows. */
function dbWith(...queue: unknown[][]): Database {
	const rest = [...queue]
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rest.shift() ?? []),
	}
	return { select: () => chain } as unknown as Database
}

const emailRow = (content: string, metadata: Record<string, unknown> = {}) => ({
	id: OBJECT_ID,
	workspaceId: WORKSPACE,
	type: 'task',
	title: 'Reply to Lars',
	content,
	metadata: { kind: 'email', to: 'Lars Honoré <lars@example.dk>', subject: 'Meeting', ...metadata },
})

const preview = (overrides: Partial<HoldPreview> = {}): HoldPreview => ({
	summary: 'Send this email',
	recipients: ['Lars Honoré <lars@example.dk>'],
	subject: 'Meeting',
	body: 'Hello Lars.',
	note: null,
	fingerprint: 'f1',
	...overrides,
})

describe('buildHoldPreview', () => {
	it('reads the recipient, subject and text of an email object as stored right now', async () => {
		const row = emailRow('Hi Lars, how about Tuesday at 10 or Wednesday at 14?')
		const result = await buildHoldPreview({
			db: dbWith([row]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { object_id: OBJECT_ID },
		})
		expect(result).toMatchObject({
			summary: 'Send this email',
			recipients: ['Lars Honoré <lars@example.dk>'],
			subject: 'Meeting',
			body: 'Hi Lars, how about Tuesday at 10 or Wednesday at 14?',
			note: null,
		})
		expect(result.fingerprint).toBe(buildObjectPreview(row)?.content_hash)
	})

	it('gives another fingerprint when the draft text is edited', async () => {
		const read = async (content: string) =>
			buildHoldPreview({
				db: dbWith([emailRow(content)]),
				workspaceId: WORKSPACE,
				tool: 'gmail_send_email',
				args: { object_id: OBJECT_ID },
			})
		const before = await read('Two slots: Tuesday or Wednesday.')
		const same = await read('Two slots: Tuesday or Wednesday.')
		const after = await read('One slot: Thursday at 9.')
		expect(same.fingerprint).toBe(before.fingerprint)
		expect(after.fingerprint).not.toBe(before.fingerprint)
		expect(after.body).toBe('One slot: Thursday at 9.')
	})

	it('says so in plain words when the draft is missing a recipient', async () => {
		const result = await buildHoldPreview({
			db: dbWith([emailRow('Hello', { to: '' })]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { object_id: OBJECT_ID },
		})
		expect(result.note).toContain('not complete')
	})

	it('says there is nothing to read when the email does not exist in this workspace', async () => {
		const result = await buildHoldPreview({
			db: dbWith([]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { object_id: OBJECT_ID },
		})
		expect(result.body).toBeNull()
		expect(result.note).toContain('does not exist in this workspace')
	})

	it('shows the text of an object that is not filed as an email and says the send will be refused', async () => {
		const result = await buildHoldPreview({
			db: dbWith([{ ...emailRow('Plain note'), metadata: {} }]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { object_id: OBJECT_ID },
		})
		expect(result.body).toBe('Plain note')
		expect(result.note).toContain('refused')
	})

	it('reads the draft on a decision card', async () => {
		const card = {
			data: {
				decision: {
					title: 'Send the reply to Lars?',
					summary: 'Lars asked for two slots. I drafted the reply.',
					ask: 'This goes out in your name, so I will not send it alone.',
					options: [
						{
							label: 'Send it',
							recommended: true,
							destructive: true,
							consequences: ['Lars gets the email', 'It cannot be undone'],
						},
						{ label: 'Hold', consequences: ['Nothing is sent', 'Lars keeps waiting'] },
					],
					draft: {
						to: 'Lars Honoré <lars@example.dk>',
						body: 'Subject: Meeting\n\nTuesday at 10?',
					},
				},
			},
		}
		const result = await buildHoldPreview({
			db: dbWith([card]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { approval_comment_id: 42 },
		})
		expect(result).toMatchObject({
			recipients: ['Lars Honoré <lars@example.dk>'],
			subject: 'Meeting',
			body: 'Tuesday at 10?',
		})
		expect(result.fingerprint).toBeTruthy()
	})

	it('says so when the card is not found', async () => {
		const result = await buildHoldPreview({
			db: dbWith([]),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { approval_comment_id: 42 },
		})
		expect(result.body).toBeNull()
		expect(result.note).toContain('no email draft')
	})

	it('says so when a send names no email at all', async () => {
		const result = await buildHoldPreview({
			db: dbWith(),
			workspaceId: WORKSPACE,
			tool: 'gmail_send_email',
			args: { to: 'a@example.com', body: 'hi' },
		})
		expect(result.note).toContain('nothing to read out')
	})

	it('previews a tool whose arguments are the text: that text and the target', async () => {
		const result = await buildHoldPreview({
			db: dbWith(),
			workspaceId: WORKSPACE,
			tool: 'post_conversation_message',
			args: { conversation_id: 'chat-1', content: 'The launch is on Friday.' },
		})
		expect(result).toMatchObject({
			summary: 'Post a message in a chat',
			recipients: ['Chat chat-1'],
			body: 'The launch is on Friday.',
		})
	})

	it('summarises any other held tool by name and its main arguments, without the workspace id', async () => {
		const result = await buildHoldPreview({
			db: dbWith(),
			workspaceId: WORKSPACE,
			tool: 'stop_session',
			args: { workspace_id: WORKSPACE, id: 'session-9' },
		})
		expect(result.summary).toBe('Run stop_session')
		expect(result.body).toBe('id: session-9')
		expect(result.body).not.toContain(WORKSPACE)
	})

	it('gives the same fingerprint for the same arguments and another for other arguments', async () => {
		const run = (content: string) =>
			buildHoldPreview({
				db: dbWith(),
				workspaceId: WORKSPACE,
				tool: 'send_session_message',
				args: { id: 's1', content },
			})
		expect((await run('go')).fingerprint).toBe((await run('go')).fingerprint)
		expect((await run('go')).fingerprint).not.toBe((await run('stop')).fingerprint)
	})
})

describe('the read-aloud rule', () => {
	const body = (chars: number) => 'A'.repeat(Math.max(0, chars))

	it('keeps the limit in one constant at 1,000 characters', () => {
		expect(VOICE_READ_ALOUD_MAX_CHARS).toBe(1000)
	})

	it('counts recipient, subject and body together', () => {
		expect(readAloudLength(preview({ recipients: ['abc'], subject: 'de', body: 'f' }))).toBe(6)
	})

	it('has the agent read the whole text up to the limit', () => {
		const p = preview({ recipients: [], subject: null, body: body(VOICE_READ_ALOUD_MAX_CHARS) })
		const text = readAloudInstruction(p, true)
		expect(text).toContain('the recipient, the subject and the whole text')
		expect(text).not.toContain('full text is in the chat')
	})

	it('has the agent read the edges above the limit, say the rest is in the chat, and read all if asked', () => {
		const middle = 'Middle sentence here. '.repeat(80)
		const p = preview({
			recipients: [],
			subject: null,
			body: `Opening one. Opening two. ${middle}Closing slot A is Tuesday. Closing slot B is Wednesday.`,
		})
		expect(readAloudLength(p)).toBeGreaterThan(VOICE_READ_ALOUD_MAX_CHARS)
		const text = readAloudInstruction(p, true)
		expect(text).toContain('Opening one.')
		expect(text).toContain('Closing slot B is Wednesday.')
		expect(text).toContain('full text is in the chat')
		expect(text).toContain('read all of it')
	})

	it('has the agent read it all when a long text could not be put in the chat', () => {
		const p = preview({ body: body(VOICE_READ_ALOUD_MAX_CHARS + 1) })
		expect(readAloudInstruction(p, false)).toContain('could not be put in the chat')
	})

	it('has the agent say what it does when there is no text', () => {
		const p = preview({ recipients: [], subject: null, body: null })
		expect(readAloudInstruction(p, true)).toContain('no text to read')
	})

	it('takes the first and last sentences without overlap, even from a short text', () => {
		const { first, last } = spokenEdges('One. Two. Three. Four.')
		expect(first).toBe('One. Two. Three.')
		expect(last).toBe('Four.')
		expect(spokenEdges('Only one sentence.')).toEqual({ first: 'Only one sentence.', last: '' })
	})

	it('keeps the end of a long text even when the model-facing body is cut', () => {
		const long = `${'Filler words go here. '.repeat(400)}The meeting slots are Tuesday and Wednesday.`
		const p = preview({ body: long })
		expect(formatHoldPreviewForModel(p)).toContain('The text is cut here')
		expect(readAloudInstruction(p, true)).toContain('The meeting slots are Tuesday and Wednesday.')
		expect(long.length).toBeGreaterThan(VOICE_HOLD_BODY_MAX_CHARS)
	})
})

describe('hold preview text', () => {
	it('shows the recipient, subject and text to the model', () => {
		const text = formatHoldPreviewForModel(preview())
		expect(text).toContain('To: Lars Honoré <lars@example.dk>')
		expect(text).toContain('Subject: Meeting')
		expect(text).toContain('Hello Lars.')
	})

	it('puts the same recipient, subject and text in the chat, quoted', () => {
		const text = formatHoldPreviewForChat(preview({ body: 'Line one.\nLine two.' }))
		expect(text).toContain('Waiting for your yes: Send this email')
		expect(text).toContain('To: Lars Honoré <lars@example.dk>')
		expect(text).toContain('Subject: Meeting')
		expect(text).toContain('> Line one.\n> Line two.')
	})

	it('keeps the chat message within the chat limit and says when it was cut', () => {
		const text = formatHoldPreviewForChat(preview({ body: 'x'.repeat(MESSAGE_MAX_LENGTH * 2) }))
		expect(text.length).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH)
		expect(text).toContain('The text is cut here')
	})
})
