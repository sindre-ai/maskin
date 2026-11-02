import { describe, expect, it, vi } from 'vitest'
import {
	INMAIL_CHAT_SPECIFICS,
	INMAIL_CREDIT_FLOOR,
	INMAIL_DAILY_CAP,
	inmailFloorReached,
} from '../../../../../lib/integrations/providers/linkedin-unipile/inmail'
import { createLinkedInHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * The InMail request body follows the Unipile v2 reference (`specifics.linkedin.classic.inmail`).
 * It is NOT captured from a live account: a wrong key is silently a plain chat start, so the
 * deploy check must see the credits drop by exactly one.
 */
function clientWithFetch() {
	const fetchImpl = vi.fn(
		async () => new Response(JSON.stringify({ object: 'ChatStarted' }), { status: 200 }),
	)
	const client = createLinkedInHttpClient({
		baseUrl: 'https://unipile.test',
		apiKey: 'k',
		fetchImpl: fetchImpl as never,
	})
	const lastBody = () => {
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		return JSON.parse(String(init.body)) as Record<string, unknown>
	}
	return { client, fetchImpl, lastBody }
}

describe('start-chat client with the InMail option', () => {
	it('carries specifics.linkedin.classic.inmail true and keeps the inbox route', async () => {
		const { client, fetchImpl, lastBody } = clientWithFetch()
		await client.sendMessage({
			account_id: 'acc_1',
			recipient_urn: 'ACoAAA1',
			body: 'Hello',
			inmail: true,
		})
		const [url] = fetchImpl.mock.calls[0] as unknown as [string]
		expect(url).toBe('https://unipile.test/v2/acc_1/inboxes/CLASSIC_PRIMARY/chats/send')
		expect(lastBody()).toEqual({
			users_ids: ['ACoAAA1'],
			text: 'Hello',
			specifics: { linkedin: { classic: { inmail: true } } },
		})
		expect(INMAIL_CHAT_SPECIFICS).toEqual({ linkedin: { classic: { inmail: true } } })
	})

	it('sends no specifics on a plain chat start', async () => {
		const { client, lastBody } = clientWithFetch()
		await client.sendMessage({ account_id: 'acc_1', recipient_urn: 'ACoAAA1', body: 'Hello' })
		expect(lastBody()).toEqual({ users_ids: ['ACoAAA1'], text: 'Hello' })
	})
})

describe('InMail floor and cap', () => {
	it('refuses at or below the floor of 2, and when classic credits are absent', () => {
		const credits = (classic: number | null) => ({
			classic,
			sales_navigator: null,
			recruiter: null,
		})
		expect(INMAIL_CREDIT_FLOOR).toBe(2)
		expect(inmailFloorReached(credits(null))).toBe(true)
		expect(inmailFloorReached(credits(0))).toBe(true)
		expect(inmailFloorReached(credits(2))).toBe(true)
		expect(inmailFloorReached(credits(3))).toBe(false)
	})

	it('caps send_inmail at 5 per rolling day', () => {
		expect(INMAIL_DAILY_CAP).toEqual({ name: 'send_inmail', limit: 5, tools: ['send_inmail'] })
	})
})
