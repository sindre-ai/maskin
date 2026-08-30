import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			slackConversations: vi.fn(),
			slackUsers: vi.fn(),
		},
	},
}))

// Mock sonner so we can assert the one-time toast + the Resume-click info
// toast without a real Toaster mount.
vi.mock('sonner', () => ({
	toast: {
		warning: vi.fn(),
		info: vi.fn(),
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
			{
				id: 'CKICKED',
				name: 'ops',
				is_private: false,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
		])
		vi.mocked(toast.warning).mockClear()
		vi.mocked(toast.info).mockClear()
		// Each test starts with an empty toast-shown ledger so the one-time
		// toast fires deterministically.
		window.localStorage.clear()
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

	// PR C — auto-paused red state
	it('renders red auto-paused banner with mapped copy + Resume button + one-time toast', async () => {
		const trigger = baseTrigger({
			enabled: false,
			metadata: {
				auto_paused: {
					reason: 'slack_member_left',
					channel_id: 'CKICKED',
					paused_at: '2026-08-30T14:00:00Z',
					previous_enabled: true,
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
		expect(banner).toHaveAttribute('data-state', 'auto-paused')
		expect(banner.textContent).toContain(
			'Auto-paused — Maskin was removed from #ops. Reinvite the app in Slack, then resume the trigger.',
		)
		expect(screen.getByTestId('slack-auto-pause-resume')).toBeInTheDocument()

		// The one-time toast fires on mount for the fresh (trigger, paused_at)
		// pair. localStorage marks it as seen so subsequent renders don't
		// re-fire.
		expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
		expect(
			window.localStorage.getItem(
				'slack-auto-pause-toast:00000000-0000-0000-0000-000000000001:2026-08-30T14:00:00Z',
			),
		).toBe('1')
	})

	it('auto-paused state wins over a concurrent setup-failure state', () => {
		const trigger = baseTrigger({
			enabled: false,
			metadata: {
				slack_setup: {
					channel_ids: ['CGONE'],
					join_attempts: [
						{
							channel_id: 'CGONE',
							status: 'channel_not_found',
							attempted_at: '2026-08-30T12:00:00Z',
						},
					],
					last_setup_at: '2026-08-30T12:00:00Z',
				},
				auto_paused: {
					reason: 'slack_member_left',
					channel_id: 'CKICKED',
					paused_at: '2026-08-30T14:00:00Z',
					previous_enabled: true,
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
		expect(banner).toHaveAttribute('data-state', 'auto-paused')
		// Setup-failure copy is NOT rendered — the red banner short-circuits.
		expect(banner.textContent).not.toContain('Channel not found')
	})

	it('Resume button surfaces the reinvite reminder toast on click (Task 4 will replace)', async () => {
		const user = userEvent.setup()
		const trigger = baseTrigger({
			enabled: false,
			metadata: {
				auto_paused: {
					reason: 'slack_member_left',
					channel_id: 'CKICKED',
					paused_at: '2026-08-30T14:00:00Z',
					previous_enabled: true,
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

		await user.click(screen.getByTestId('slack-auto-pause-resume'))
		expect(vi.mocked(toast.info)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toContain('#ops')
	})
})
