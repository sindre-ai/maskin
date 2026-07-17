import {
	LinkedinChannelsSection,
	LinkedinHeroPill,
} from '@/components/agents/linkedin-connect-section'
import type { LinkedinAccountResponse, LinkedinAccountState } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		linkedin: {
			account: vi.fn(),
			connect: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { api } from '@/lib/api'

const workspaceId = '00000000-0000-0000-0000-000000000001'
const agentId = '11111111-1111-1111-1111-111111111111'

function buildAccount(overrides: Partial<LinkedinAccountResponse>): LinkedinAccountResponse {
	return {
		id: 'acc-1',
		workspaceId,
		state: 'healthy' as LinkedinAccountState,
		unipileAccountId: 'unipile-1',
		sendingAsName: 'Sebastian Bakke',
		sendingAsProviderId: 'urn:li:1',
		connectedAt: '2026-07-10T12:00:00.000Z',
		createdAt: null,
		updatedAt: null,
		pacing: {
			dailyCap: 20,
			dailySent: 4,
			weeklyCap: 80,
			weeklySent: 18,
			warmup: null,
		},
		acceptanceRate: 0.62,
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('LinkedinChannelsSection — state coverage', () => {
	it('renders the empty state with a Connect LinkedIn CTA when no account exists', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(null)
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByRole('button', { name: /connect linkedin/i })).toBeInTheDocument()
		// No account panel until an account row exists.
		expect(screen.queryByText(/sending as/i)).not.toBeInTheDocument()
	})

	it('renders the handoff state with a Reopen Unipile control', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(buildAccount({ state: 'handoff' }))
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByRole('button', { name: /reopen unipile/i })).toBeInTheDocument()
	})

	it('renders the syncing state with a disabled syncing button and info callout', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(
			buildAccount({
				state: 'syncing',
				pacing: { dailyCap: 0, dailySent: 0, weeklyCap: 0, weeklySent: 0, warmup: null },
			}),
		)
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		const syncButton = await screen.findByRole('button', { name: /syncing/i })
		expect(syncButton).toBeDisabled()
		expect(screen.getByText(/first-sync in progress/i)).toBeInTheDocument()
	})

	it('renders the warm-up state with day/total in the callout and the warm-up pacing caps', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(
			buildAccount({
				state: 'warm_up',
				pacing: {
					dailyCap: 5,
					dailySent: 2,
					weeklyCap: 25,
					weeklySent: 9,
					warmup: { day: 3, total: 14 },
				},
				acceptanceRate: null,
			}),
		)
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByText(/warm-up · day 3 of 14/i)).toBeInTheDocument()
		expect(screen.getByText('2 / 5')).toBeInTheDocument()
		expect(screen.getByText('9 / 25')).toBeInTheDocument()
	})

	it('renders the healthy state with sending-as identity, pacing counters, and acceptance rate', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(buildAccount({ state: 'healthy' }))
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByText('Sebastian Bakke')).toBeInTheDocument()
		expect(screen.getByText('4 / 20')).toBeInTheDocument()
		expect(screen.getByText('18 / 80')).toBeInTheDocument()
		expect(screen.getByText(/acceptance 62%/i)).toBeInTheDocument()
	})

	it('renders the reconnect state with a Reconnect CTA and a warn callout', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(buildAccount({ state: 'reconnect' }))
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByRole('button', { name: /reconnect/i })).toBeInTheDocument()
		expect(screen.getByText(/linkedin signed you out/i)).toBeInTheDocument()
	})

	it('renders the restricted state WITHOUT a reconnect CTA and with an error callout', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(buildAccount({ state: 'restricted' }))
		render(
			<TestWrapper>
				<LinkedinChannelsSection agentId={agentId} workspaceId={workspaceId} />
			</TestWrapper>,
		)
		await screen.findByText(/restricted by linkedin/i)
		expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: /recovery guide/i })).toBeInTheDocument()
	})
})

describe('LinkedinHeroPill', () => {
	it('renders "Needs LinkedIn" when no account is connected', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(null)
		render(
			<TestWrapper>
				<LinkedinHeroPill workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByText(/needs linkedin/i)).toBeInTheDocument()
	})

	it('renders the warm-up day/total on the pill', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(
			buildAccount({
				state: 'warm_up',
				pacing: {
					dailyCap: 5,
					dailySent: 0,
					weeklyCap: 25,
					weeklySent: 0,
					warmup: { day: 5, total: 14 },
				},
			}),
		)
		render(
			<TestWrapper>
				<LinkedinHeroPill workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByText(/warming up · day 5 of 14/i)).toBeInTheDocument()
	})

	it('renders "Restricted · stopped" for the restricted state', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(buildAccount({ state: 'restricted' }))
		render(
			<TestWrapper>
				<LinkedinHeroPill workspaceId={workspaceId} />
			</TestWrapper>,
		)
		expect(await screen.findByText(/restricted · stopped/i)).toBeInTheDocument()
	})
})
