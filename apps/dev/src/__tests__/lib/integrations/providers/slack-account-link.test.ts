import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	_internals,
	buildAccountLinkBlocks,
} from '../../../../lib/integrations/providers/slack/account-link'

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
