import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			slackConversations: vi.fn(),
			slackUsers: vi.fn(),
		},
	},
}))

import { SlackTriggerSetupStatus } from '@/components/triggers/slack-trigger-setup-status'
import { api } from '@/lib/api'
import type { TriggerResponse } from '@/lib/api'
import { TestWrapper } from '../../setup'

function baseTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: '00000000-0000-0000-0000-000000000001',
		workspaceId: '00000000-0000-0000-0000-000000000002',
		name: 'Alerts',
		type: 'event',
		config: null,
		actionPrompt: 'Do the thing',
		targetActorId: '00000000-0000-0000-0000-000000000003',
		enabled: true,
		metadata: null,
		createdBy: '00000000-0000-0000-0000-000000000004',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

describe('SlackTriggerSetupStatus', () => {
	beforeEach(() => {
		vi.mocked(api.integrations.slackConversations).mockResolvedValue([
			{
				id: 'CPRIV',
				name: 'founders',
				is_private: true,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
			{
				id: 'CGONE',
				name: 'gone-channel',
				is_private: false,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
			{
				id: 'CGOOD',
				name: 'general',
				is_private: false,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
		])
	})

	it('renders yellow failure banner with mapped per-channel copy for setup failures', () => {
		const trigger = baseTrigger({
			metadata: {
				slack_setup: {
					channel_ids: ['CPRIV', 'CGONE'],
					join_attempts: [
						{
							channel_id: 'CPRIV',
							status: 'not_public',
							attempted_at: '2026-08-30T12:00:00Z',
						},
						{
							channel_id: 'CGONE',
							status: 'channel_not_found',
							attempted_at: '2026-08-30T12:00:00Z',
						},
					],
					last_setup_at: '2026-08-30T12:00:00Z',
				},
			},
		})

		render(
			<TestWrapper>
				<SlackTriggerSetupStatus
					trigger={trigger}
					integrationId="int-1"
					workspaceId="ws-1"
				/>
			</TestWrapper>,
		)

		const banner = screen.getByTestId('slack-trigger-setup-status')
		expect(banner).toHaveAttribute('data-state', 'setup-failure')
		// `#founders` name is resolved from the useSlackConversations cache; the
		// exact copy comes from `slack-setup-copy.ts` (spec §3 mapping).
		expect(banner.textContent).toContain(
			"Private channel — Slack won't let Maskin auto-join. In Slack: /invite @Maskin #founders",
		)
		expect(banner.textContent).toContain(
			'Channel not found — it may have been archived or renamed.',
		)
	})

	it('renders nothing when every join attempt is a success', () => {
		const trigger = baseTrigger({
			metadata: {
				slack_setup: {
					channel_ids: ['CGOOD'],
					join_attempts: [
						{
							channel_id: 'CGOOD',
							status: 'joined',
							attempted_at: '2026-08-30T12:00:00Z',
						},
					],
					confirmation_posted_at: { CGOOD: '2026-08-30T12:00:01Z' },
					last_setup_at: '2026-08-30T12:00:01Z',
				},
			},
		})

		const { container } = render(
			<TestWrapper>
				<SlackTriggerSetupStatus
					trigger={trigger}
					integrationId="int-1"
					workspaceId="ws-1"
				/>
			</TestWrapper>,
		)

		expect(container.querySelector('[data-testid="slack-trigger-setup-status"]')).toBeNull()
	})

	it('renders nothing when metadata.slack_setup is absent (pre-flag, non-Slack)', () => {
		const trigger = baseTrigger({ metadata: null })

		const { container } = render(
			<TestWrapper>
				<SlackTriggerSetupStatus
					trigger={trigger}
					integrationId="int-1"
					workspaceId="ws-1"
				/>
			</TestWrapper>,
		)

		expect(container.querySelector('[data-testid="slack-trigger-setup-status"]')).toBeNull()
	})
})
