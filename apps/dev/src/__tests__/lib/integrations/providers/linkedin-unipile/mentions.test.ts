import { describe, expect, it } from 'vitest'
import { validateMentions } from '../../../../../lib/integrations/providers/linkedin-unipile/mentions'
import { createLinkedInHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * Tags (mentions) on the four LinkedIn write routes. Unipile documents `mentions: [{ name,
 * profile_id }]` with {{0}}, {{1}} markers for comments only; the same shape is sent on posts and
 * edits, so these tests pin what goes on the wire until a live call confirms it. A call with no
 * tags must send exactly the body it sent before.
 */
function recordingClient() {
	const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = []
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ method: String(init.method), url, body: JSON.parse(String(init.body)) })
		return new Response(JSON.stringify({ id: 'x' }), { status: 200 })
	}) as unknown as typeof fetch
	const client = createLinkedInHttpClient({
		baseUrl: 'https://api.unipile.test',
		apiKey: 'k',
		fetchImpl,
	})
	return { client, calls }
}

const person = { name: 'Jane Doe', profile_id: 'ACoAAAjane' }
const company = { name: 'Acme', profile_id: '12345' }
const mentions = [person, company]
const text = 'Thanks {{0}} and {{1}}!'

describe('mentions on the wire', () => {
	it('publishes a post with one person and one company', async () => {
		const { client, calls } = recordingClient()
		await client.publishPost({ account_id: 'acc_1', text, mentions })
		expect(calls[0].url).toBe('https://api.unipile.test/v2/acc_1/posts')
		expect(calls[0].body).toEqual({ text, mentions })
	})

	it('keeps mentions next to post_as when posting as a page', async () => {
		const { client, calls } = recordingClient()
		await client.publishPost({
			account_id: 'acc_1',
			text,
			mentions,
			post_as: 'urn:li:organization:42',
		})
		expect(calls[0].body).toEqual({ text, mentions, post_as: '42' })
	})

	it('edits a post with one person and one company', async () => {
		const { client, calls } = recordingClient()
		await client.editPost({ account_id: 'acc_1', post_id: 'p1', text, mentions })
		expect(calls[0].method).toBe('PATCH')
		expect(calls[0].url).toBe('https://api.unipile.test/v2/acc_1/posts/p1')
		expect(calls[0].body).toEqual({ text, mentions })
	})

	it('comments on a post with one person and one company', async () => {
		const { client, calls } = recordingClient()
		await client.commentOnPost({ account_id: 'acc_1', post_id: 'p1', text, mentions })
		expect(calls[0].url).toBe('https://api.unipile.test/v2/acc_1/posts/p1/comments')
		expect(calls[0].body).toEqual({ text, mentions })
	})

	it('replies to a comment with one person and one company', async () => {
		const { client, calls } = recordingClient()
		await client.replyToComment({ account_id: 'acc_1', comment_id: 'c1', text, mentions })
		expect(calls[0].url).toBe('https://api.unipile.test/v2/acc_1/comments/c1/replies')
		expect(calls[0].body).toEqual({ text, mentions })
	})

	it('sends the exact old body when there are no tags', async () => {
		const { client, calls } = recordingClient()
		await client.publishPost({ account_id: 'acc_1', text: 'plain' })
		await client.publishPost({ account_id: 'acc_1', text: 'plain', mentions: [] })
		await client.editPost({ account_id: 'acc_1', post_id: 'p1', text: 'plain', mentions: [] })
		await client.commentOnPost({ account_id: 'acc_1', post_id: 'p1', text: 'plain' })
		await client.commentOnPost({ account_id: 'acc_1', post_id: 'p1', text: 'plain', mentions: [] })
		await client.replyToComment({ account_id: 'acc_1', comment_id: 'c1', text: 'plain' })
		await client.replyToComment({
			account_id: 'acc_1',
			comment_id: 'c1',
			text: 'plain',
			mentions: [],
		})
		expect(calls.map((c) => c.body)).toEqual([
			{ text: 'plain' },
			{ text: 'plain' },
			{ text: 'plain' },
			{ text: 'plain' },
			{ text: 'plain' },
			{ text: 'plain' },
			{ text: 'plain' },
		])
	})
})

describe('validateMentions', () => {
	it('returns nothing for no tags, even when the text holds a literal {{0}}', () => {
		expect(validateMentions('hello', undefined)).toBeUndefined()
		expect(validateMentions('hello', [])).toBeUndefined()
		expect(validateMentions('keep {{0}} as typed', undefined)).toBeUndefined()
	})

	it('returns the trimmed entries when every marker has an entry and back', () => {
		expect(
			validateMentions(text, [{ name: ' Jane Doe ', profile_id: ' ACoAAAjane ' }, company]),
		).toEqual(mentions)
		expect(validateMentions('{{1}} before {{0}}, {{0}} again', mentions)).toEqual(mentions)
	})

	it('refuses a marker with no entry', () => {
		expect(() => validateMentions('Hi {{0}} and {{2}}', mentions)).toThrow(/\{\{2\}\}/)
	})

	it('refuses an entry whose marker is not in the text', () => {
		expect(() => validateMentions('Hi {{0}}', mentions)).toThrow(/mentions\[1\]/)
		expect(() => validateMentions('Hi @Jane', [person])).toThrow(/mentions\[0\]/)
	})

	it('refuses tags without text, a missing id or name, a non-list and too many tags', () => {
		expect(() => validateMentions(undefined, mentions)).toThrow(/needs text/)
		expect(() => validateMentions('{{0}}', [{ name: 'Jane', profile_id: '' }])).toThrow(
			/profile_id/,
		)
		expect(() => validateMentions('{{0}}', [{ name: '', profile_id: 'x' }])).toThrow(/name/)
		expect(() => validateMentions('{{0}}', 'Jane')).toThrow(/list/)
		const many = Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, profile_id: `${i}` }))
		expect(() => validateMentions(many.map((_, i) => `{{${i}}}`).join(' '), many)).toThrow(/20/)
	})
})
