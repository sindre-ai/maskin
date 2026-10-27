import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensureConversation = vi.fn()
vi.mock('../../services/voice-transcript', () => ({
	ensureVoiceConversation: (...args: unknown[]) => ensureConversation(...args),
}))

const insertMessage = vi.fn()
vi.mock('../../services/conversation-messages', () => ({
	insertConversationMessage: (...args: unknown[]) => insertMessage(...args),
}))

const {
	VOICE_SHOW_IN_CHAT_MAX_ITEMS,
	VoiceShowInChatError,
	showInChat,
	voiceShowInChatTool,
	VOICE_SHOW_IN_CHAT_TOOL,
} = await import('../../services/voice-show-in-chat')

const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const OBJECT_A = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'
const OBJECT_B = '7dbf5c6e-df81-4365-8fa2-9e4b1f35c886'
const BASE = 'https://app.test'

const session = {
	id: '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664',
	workspaceId: WORKSPACE,
	humanActorId: '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442',
	agentActorId: '4a8d2f3b-ac5e-4032-9d7f-6b1e8c02f553',
}

/** A db whose object lookup returns `rows`, whatever the ids asked for. */
function dbReturning(rows: Array<{ id: string; title: string }>) {
	const where = vi.fn().mockResolvedValue(rows)
	const select = vi.fn(() => ({ from: () => ({ where }) }))
	return { db: { select } as unknown as Database, select }
}

const run = (db: Database, args: unknown) =>
	showInChat({ db, session, agentName: 'Chief', args, webAppBaseUrl: BASE })

beforeEach(() => {
	ensureConversation.mockReset().mockResolvedValue('conv-1')
	insertMessage.mockReset().mockResolvedValue({ id: 42 })
})

describe('showInChat', () => {
	it.each([
		['a markdown link', '[click here](javascript:alert(1))', 'click herejavascript:alert1'],
		['an image', '![x](https://evil.example/a.png)', 'xevil.example/a.png'],
		['an autolink', 'see https://evil.example/pay now', 'see evil.example/pay now'],
		['a www address', 'go to www.evil.example', 'go to evil.example'],
		['html', '<a href="https://evil.example">hi</a>', 'a href="evil.example"hi/a'],
	])('turns a caption with %s into plain text', async (_label, caption, expected) => {
		const { db } = dbReturning([{ id: OBJECT_A, title: 'Reply to Anna' }])
		await run(db, { object_ids: [OBJECT_A], caption })
		const content = insertMessage.mock.calls[0]?.[1].content as string
		expect(content.split('\n\n')[0]).toBe(expected)
		expect(content.split('\n\n')[0]).not.toMatch(/[[\]()<>!]|https?:\/\//)
	})

	it('refuses a link that is too long once encoded, and posts nothing', async () => {
		const { db } = dbReturning([])
		const long = `https://example.com/${'(a)'.repeat(300)}`
		await expect(run(db, { links: [{ url: long }] })).rejects.toBeInstanceOf(VoiceShowInChatError)
		expect(insertMessage).not.toHaveBeenCalled()
	})

	it('keeps the longest allowed message under the chat limit', async () => {
		const { db } = dbReturning([])
		const near = `https://example.com/${'(a)'.repeat(60)}` // under the cap once encoded
		const links = Array.from({ length: 5 }, (_, i) => ({
			url: `${near}${i}`,
			label: '[x]'.repeat(40),
		}))
		await run(db, { links, caption: 'c'.repeat(1000) })
		const content = insertMessage.mock.calls[0]?.[1].content as string
		expect(content.length).toBeLessThan(8000)
	})

	it('drops @ from a caption so an address cannot turn into a mail link', async () => {
		const { db } = dbReturning([{ id: OBJECT_A, title: 'Reply to Anna' }])
		await run(db, { object_ids: [OBJECT_A], caption: 'mail evil@example.com now' })
		const content = insertMessage.mock.calls[0]?.[1].content as string
		expect(content.split('\n\n')[0]).toBe('mail evilexample.com now')
	})

	it('posts one message as the agent into the call conversation, tagged voice', async () => {
		const { db } = dbReturning([{ id: OBJECT_A, title: 'Reply to Anna' }])
		const result = await run(db, {
			object_ids: [OBJECT_A],
			links: [{ url: 'https://example.com/connect?x=1', label: 'Connect Gmail' }],
			caption: 'Here is\nthe draft',
		})

		expect(result).toEqual({ conversationId: 'conv-1', messageId: 42 })
		expect(insertMessage).toHaveBeenCalledTimes(1)
		const args = insertMessage.mock.calls[0]?.[1]
		expect(args).toMatchObject({
			conversationId: 'conv-1',
			workspaceId: WORKSPACE,
			actorId: session.agentActorId,
			metadata: { source: 'voice', voice_session_id: session.id, kind: 'show' },
			sessionId: null,
		})
		expect(args.content).toBe(
			[
				'Here is the draft',
				`[Reply to Anna](${BASE}/${WORKSPACE}/objects/${OBJECT_A})`,
				'[Connect Gmail](https://example.com/connect?x=1)',
			].join('\n\n'),
		)
	})

	it('rejects an object id that is not in the call workspace and posts nothing', async () => {
		const { db } = dbReturning([{ id: OBJECT_A, title: 'Mine' }])
		await expect(run(db, { object_ids: [OBJECT_A, OBJECT_B] })).rejects.toThrow(
			new RegExp(OBJECT_B),
		)
		expect(insertMessage).not.toHaveBeenCalled()
	})

	it('caps the list', async () => {
		const { db } = dbReturning([])
		const links = Array.from({ length: VOICE_SHOW_IN_CHAT_MAX_ITEMS + 1 }, (_, i) => ({
			url: `https://example.com/${i}`,
		}))
		await expect(run(db, { links })).rejects.toBeInstanceOf(VoiceShowInChatError)
		expect(insertMessage).not.toHaveBeenCalled()
	})

	it.each([
		'javascript:alert(1)',
		'ftp://example.com/a',
		'not a url',
		'https://user:pw@example.com/',
	])('refuses the link %s', async (url) => {
		const { db } = dbReturning([])
		await expect(run(db, { links: [{ url }] })).rejects.toBeInstanceOf(VoiceShowInChatError)
		expect(insertMessage).not.toHaveBeenCalled()
	})

	it('refuses an empty call and a malformed id', async () => {
		const { db } = dbReturning([])
		await expect(run(db, {})).rejects.toBeInstanceOf(VoiceShowInChatError)
		await expect(run(db, { object_ids: ['nope'] })).rejects.toBeInstanceOf(VoiceShowInChatError)
	})

	it('keeps brackets and parentheses from breaking the markdown link', async () => {
		const { db } = dbReturning([])
		await run(db, { links: [{ url: 'https://example.com/a(b)', label: 'x] [y' }] })
		expect(insertMessage.mock.calls[0]?.[1].content).toBe(
			'[x\\] \\[y](https://example.com/a%28b%29)',
		)
	})

	it('labels an unlabelled link with its host', async () => {
		const { db } = dbReturning([])
		await run(db, { links: [{ url: 'https://example.com/path' }] })
		expect(insertMessage.mock.calls[0]?.[1].content).toBe('[example.com](https://example.com/path)')
	})
})

describe('show_in_chat tool definition', () => {
	it('is a function tool with the agreed name', () => {
		expect(voiceShowInChatTool.name).toBe(VOICE_SHOW_IN_CHAT_TOOL)
		expect(voiceShowInChatTool.type).toBe('function')
	})
})
