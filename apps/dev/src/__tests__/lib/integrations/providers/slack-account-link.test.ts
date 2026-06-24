import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	_internals,
	buildAccountLinkBlocks,
	maybePromptAccountLink,
} from '../../../../lib/integrations/providers/slack/account-link'
import { createTestContext } from '../../../setup'

// `decrypt` is called by `readBotToken` on the integration credentials before
// any Slack API call. The unit suite doesn't exercise envelope crypto — the
// integration suite does — so stub it to round-trip whatever ciphertext the
// test passes in. Keeps these tests independent of `INTEGRATION_ENCRYPTION_KEY`.
vi.mock('../../../../lib/crypto', () => ({
	decrypt: (s: string) => s,
	encrypt: (s: string) => s,
}))

describe('buildAccountLinkBlocks', () => {
	const baseArgs = {
		frontendUrl: 'https://maskin.io',
		slackTeamId: 'T100',
		slackUserId: 'U200',
	}

	it('emits the "no Maskin account" CTA when the Slack email does not resolve to an actor', () => {
		const blocks = buildAccountLinkBlocks({
			...baseArgs,
			actorEmail: null,
			workspaces: [],
		})
		const text = (blocks[0] as { text?: { text?: string } })?.text?.text
		expect(text).toMatch(/recognise this Slack user/i)
		// CTA button points at the workspace URL prefix passed in.
		const buttons = (blocks[1] as { elements?: Array<{ url?: string }> })?.elements
		expect(buttons?.[0]?.url).toBe('https://maskin.io')
	})

	it("warns when the actor exists but Maskin isn't installed in any of their workspaces", () => {
		const blocks = buildAccountLinkBlocks({
			...baseArgs,
			actorEmail: 'sebastian@meshfirm.com',
			workspaces: [],
		})
		// No picker / no actions block when there's nothing to pick.
		expect(blocks).toHaveLength(1)
		const text = (blocks[0] as { text?: { text?: string } })?.text?.text
		expect(text).toMatch(/Ask a workspace owner to connect Slack/i)
	})

	it('emits a workspace picker + default checkbox + confirm button when options exist', () => {
		const blocks = buildAccountLinkBlocks({
			...baseArgs,
			actorEmail: 'sebastian@meshfirm.com',
			workspaces: [
				{ id: 'w1', name: 'Mesh Firm' },
				{ id: 'w2', name: 'Side Project' },
			],
		})
		// Helper text + input + checkbox actions block + primary confirm button.
		expect(blocks).toHaveLength(4)

		const picker = blocks[1] as {
			type: string
			block_id?: string
			element?: { action_id?: string; options?: Array<{ value?: string }> }
		}
		expect(picker.type).toBe('input')
		expect(picker.block_id).toBe(
			`${_internals.BLOCK_ID_PREFIX}:picker:${baseArgs.slackTeamId}:${baseArgs.slackUserId}`,
		)
		expect(picker.element?.action_id).toBe(_internals.WORKSPACE_SELECT_ACTION)
		expect(picker.element?.options?.map((o) => o.value)).toEqual(['w1', 'w2'])

		const checkbox = blocks[2] as {
			elements?: Array<{ action_id?: string; initial_options?: Array<{ value?: string }> }>
		}
		expect(checkbox.elements?.[0]?.action_id).toBe(_internals.SET_DEFAULT_ACTION)
		// Default-checked so users don't need to think about it for the first link.
		expect(checkbox.elements?.[0]?.initial_options?.[0]?.value).toBe('set_default')

		const confirm = blocks[3] as { elements?: Array<{ action_id?: string; style?: string }> }
		expect(confirm.elements?.[0]?.action_id).toBe(_internals.CONFIRM_ACTION)
		expect(confirm.elements?.[0]?.style).toBe('primary')
	})

	it('caps options at 100 (Slack static_select limit) and sorts by workspace name', () => {
		const workspaces = Array.from({ length: 150 }, (_, i) => ({
			id: `w${i}`,
			name: `Workspace ${String(150 - i).padStart(3, '0')}`,
		}))
		const blocks = buildAccountLinkBlocks({
			...baseArgs,
			actorEmail: 'sebastian@meshfirm.com',
			workspaces,
		})
		const picker = blocks[1] as { element?: { options?: Array<{ value?: string }> } }
		expect(picker.element?.options?.length).toBe(100)
		// First option is the lexicographically smallest name post-sort.
		expect(picker.element?.options?.[0]?.value).toBe('w149')
	})
})

// dispatchAccountLinkAction is exercised by the integration test suite because
// it round-trips against the slack_user_links + integrations tables; mocking
// the Drizzle chain meaningfully here adds line coverage without behavioural
// confidence. See apps/dev/src/__tests__/integration/slack-account-link.test.ts.

describe('maybePromptAccountLink', () => {
	const baseArgs = {
		integrationId: 'integration-1',
		integrationCredentials: JSON.stringify({ accessToken: 'xoxb-test-bot-token' }),
		slackTeamId: 'T100',
		slackUserId: 'U200',
		channelId: 'C300',
		frontendUrl: 'https://maskin.io',
	}

	function stubSlackFetch(opts: {
		usersInfoEmail?: string | null
		usersInfoIsBot?: boolean
		postEphemeralOk?: boolean
		postEphemeralError?: string
	}) {
		const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = []
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			const u = typeof url === 'string' ? url : url.toString()
			let parsedBody: unknown
			if (init?.body && typeof init.body === 'string') {
				try {
					parsedBody = JSON.parse(init.body)
				} catch {
					parsedBody = init.body
				}
			}
			calls.push({ url: u, init, body: parsedBody })
			if (u.includes('users.info')) {
				return {
					ok: true,
					json: async () => ({
						ok: true,
						user: {
							id: baseArgs.slackUserId,
							profile: opts.usersInfoEmail ? { email: opts.usersInfoEmail } : {},
							is_bot: opts.usersInfoIsBot ?? false,
						},
					}),
				} as unknown as Response
			}
			if (u.includes('chat.postEphemeral')) {
				return {
					ok: true,
					json: async () => ({
						ok: opts.postEphemeralOk ?? true,
						error: opts.postEphemeralError,
					}),
				} as unknown as Response
			}
			throw new Error(`unexpected fetch in test: ${u}`)
		})
		return { spy, calls }
	}

	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('returns false and posts nothing when a slack_user_links row already exists', async () => {
		const { db, mockResults } = createTestContext()
		// First (and only) DB call: the existing-link lookup. A non-empty row
		// short-circuits before we hit Slack.
		mockResults.selectQueue = [[{ slackUserId: baseArgs.slackUserId }]]
		const { spy, calls } = stubSlackFetch({})

		const result = await maybePromptAccountLink({ ...baseArgs, db })

		expect(result).toBe(false)
		expect(spy).not.toHaveBeenCalled()
		expect(calls).toHaveLength(0)
	})

	it('posts the workspace picker and returns true when the user has linkable Maskin workspaces', async () => {
		const { db, mockResults } = createTestContext()
		// Drizzle call order in the unlinked + N-workspace path:
		//   1. slack_user_links existing-link lookup  → []
		//   2. actors lookup by email                 → [actor row]
		//   3. integrations rows for (provider=slack, team, active)
		//   4. workspaceMembers rows for (actor, in integration workspaces)
		//   5. workspaces rows for the matched ids (name lookup)
		mockResults.selectQueue = [
			[],
			[{ id: 'actor-1', email: 'sebastian@meshfirm.com' }],
			[{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
			[{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
			[
				{ id: 'w1', name: 'Mesh Firm' },
				{ id: 'w2', name: 'Side Project' },
			],
		]
		const { calls } = stubSlackFetch({ usersInfoEmail: 'sebastian@meshfirm.com' })

		const result = await maybePromptAccountLink({ ...baseArgs, db })

		expect(result).toBe(true)
		const postCalls = calls.filter((c) => c.url.includes('chat.postEphemeral'))
		expect(postCalls).toHaveLength(1)

		const body = postCalls[0]?.body as {
			channel?: string
			user?: string
			blocks?: Array<{ block_id?: string; type?: string }>
		}
		expect(body.channel).toBe(baseArgs.channelId)
		expect(body.user).toBe(baseArgs.slackUserId)

		const blockIds = (body.blocks ?? []).map((b) => b.block_id).filter(Boolean)
		expect(blockIds).toContain(
			`${_internals.BLOCK_ID_PREFIX}:picker:${baseArgs.slackTeamId}:${baseArgs.slackUserId}`,
		)
		expect(blockIds).toContain(
			`${_internals.BLOCK_ID_PREFIX}:default:${baseArgs.slackTeamId}:${baseArgs.slackUserId}`,
		)
		expect(blockIds).toContain(
			`${_internals.BLOCK_ID_PREFIX}:confirm:${baseArgs.slackTeamId}:${baseArgs.slackUserId}`,
		)
	})

	it('posts the "no workspace installed Maskin yet" variant when the actor resolves but has zero linkable workspaces', async () => {
		const { db, mockResults } = createTestContext()
		// Call order: existing-link [] → actor row → integrations [] (short-circuits
		// resolveLinkableWorkspaces before the member/workspace lookups).
		mockResults.selectQueue = [[], [{ id: 'actor-1', email: 'sebastian@meshfirm.com' }], []]
		const { calls } = stubSlackFetch({ usersInfoEmail: 'sebastian@meshfirm.com' })

		const result = await maybePromptAccountLink({ ...baseArgs, db })

		expect(result).toBe(true)
		const postCalls = calls.filter((c) => c.url.includes('chat.postEphemeral'))
		expect(postCalls).toHaveLength(1)

		const body = postCalls[0]?.body as {
			blocks?: Array<{ text?: { text?: string } }>
		}
		// The zero-workspace variant is a single section block with the install-CTA copy.
		expect(body.blocks).toHaveLength(1)
		expect(body.blocks?.[0]?.text?.text).toMatch(/Ask a workspace owner to connect Slack/i)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})
})

describe('account-link constants', () => {
	beforeEach(() => {
		vi.useRealTimers()
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('exports stable block ids so T6 can route on the prefix', () => {
		expect(_internals.BLOCK_ID_PREFIX).toBe('maskin_account_link')
		expect(_internals.WORKSPACE_SELECT_ACTION).toMatch(/^maskin_account_link:/)
		expect(_internals.SET_DEFAULT_ACTION).toMatch(/^maskin_account_link:/)
		expect(_internals.CONFIRM_ACTION).toMatch(/^maskin_account_link:/)
	})
})
