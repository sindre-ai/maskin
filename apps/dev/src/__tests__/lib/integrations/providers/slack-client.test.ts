import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	_resetSlackCaches,
	listSlackConversations,
} from '../../../../lib/integrations/providers/slack/client'

describe('listSlackConversations — is_member mapping', () => {
	beforeEach(() => {
		_resetSlackCaches()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('carries the is_member flag through the mapper for public and private channels', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					ok: true,
					channels: [
						{
							id: 'C_MEMBER',
							name: 'general',
							is_channel: true,
							is_private: false,
							is_member: true,
						},
						{
							id: 'C_NON_MEMBER',
							name: 'stray',
							is_channel: true,
							is_private: false,
							is_member: false,
						},
						{
							id: 'G_PRIVATE_MEMBER',
							name: 'planning',
							is_channel: true,
							is_private: true,
							is_member: true,
						},
					],
					response_metadata: {},
				}),
		} as unknown as Response)

		const conversations = await listSlackConversations(
			'integration-1',
			'xoxb-token',
			['public_channel', 'private_channel'],
		)

		const byId = new Map(conversations.map((c) => [c.id, c]))
		expect(byId.get('C_MEMBER')?.is_member).toBe(true)
		expect(byId.get('C_NON_MEMBER')?.is_member).toBe(false)
		expect(byId.get('G_PRIVATE_MEMBER')?.is_member).toBe(true)
	})

	it('defaults is_member to true for DMs and MPIMs even when Slack omits the field', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			json: () =>
				Promise.resolve({
					ok: true,
					channels: [
						// DM — Slack does not send is_member; presence in the response
						// implies the bot is a participant.
						{ id: 'D_1', name: '', is_im: true },
						// MPIM — same idea.
						{ id: 'M_1', name: 'mpdm-alice--bob-1', is_mpim: true },
					],
					response_metadata: {},
				}),
		} as unknown as Response)

		const conversations = await listSlackConversations(
			'integration-2',
			'xoxb-token',
			['im', 'mpim'],
		)

		const byId = new Map(conversations.map((c) => [c.id, c]))
		expect(byId.get('D_1')?.is_member).toBe(true)
		expect(byId.get('M_1')?.is_member).toBe(true)
	})
})
