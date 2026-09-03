import { ApiError, type ClaudeOAuthSlotInfo } from '@/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockStatus = vi.fn()
const mockImport = vi.fn()
const mockDisconnect = vi.fn()
const mockSwap = vi.fn()
const mockPromote = vi.fn()
const mockRename = vi.fn()

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			claudeOauth: {
				status: (...args: unknown[]) => mockStatus(...args),
				import: (...args: unknown[]) => mockImport(...args),
				disconnect: (...args: unknown[]) => mockDisconnect(...args),
				swap: (...args: unknown[]) => mockSwap(...args),
				promote: (...args: unknown[]) => mockPromote(...args),
				rename: (...args: unknown[]) => mockRename(...args),
			},
		},
	}
})

const mockWorkspaceWithRole = {
	id: 'ws-1',
	name: 'Test Workspace',
	role: 'owner' as const,
	settings: {},
	enterprise: true,
	createdBy: 'actor-1',
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
}

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: mockWorkspaceWithRole,
		workspaceId: mockWorkspaceWithRole.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/keys'

const KeysPage = Route.options.component as () => React.ReactElement

function renderPage() {
	return render(
		<TestWrapper>
			<KeysPage />
		</TestWrapper>,
	)
}

const MAX_SLOTS = 10
const HOUR = 60 * 60 * 1000

/**
 * Build a status response the way the API returns it: slots keyed by id, plus
 * the `chain` that gives their failover order. Every slot in `slots` is
 * assumed connected, in the order given.
 */
function statusFixture(
	slots: Array<Partial<ClaudeOAuthSlotInfo> & { slot: string }>,
	extra: Record<string, unknown> = {},
) {
	const bySlot: Record<string, ClaudeOAuthSlotInfo> = {}
	slots.forEach((slot, position) => {
		bySlot[slot.slot] = {
			position,
			expires_at: Date.now() + 240 * HOUR,
			...slot,
		}
	})
	return {
		connected: slots.length > 0,
		valid: slots.length > 0,
		slots: bySlot,
		chain: slots.map((s) => s.slot),
		slots_remaining: MAX_SLOTS - slots.length,
		active_slot: slots[0]?.slot ?? 'primary',
		...extra,
	}
}

describe('Settings > Keys > Claude Subscriptions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders a single dashed card inviting the first import when nothing is connected', async () => {
		mockStatus.mockResolvedValue(statusFixture([]))

		renderPage()

		expect(await screen.findByText('Claude Subscriptions')).toBeInTheDocument()
		expect(await screen.findByText('No subscription connected')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Import credentials' })).toBeInTheDocument()
	})

	it('renders connected subscriptions in chain order with the active one marked In use', async () => {
		mockStatus.mockResolvedValue(
			statusFixture([
				{ slot: 'primary', subscription_type: 'max-5x' },
				{ slot: 'backup', subscription_type: 'pro', fingerprint: 'backup123' },
			]),
		)

		renderPage()

		const primary = await screen.findByTestId('slot-primary')
		const backup = screen.getByTestId('slot-backup')
		await waitFor(() => expect(primary).toHaveTextContent('In use'))
		expect(primary).toHaveTextContent('Connected')
		expect(backup).toHaveTextContent('Connected')
		expect(backup).toHaveTextContent('id backup123')
		expect(backup).not.toHaveTextContent('In use')
		expect(screen.queryByTestId('failover-banner')).not.toBeInTheDocument()
	})

	it('renders more than two subscriptions, labelled by their position in the chain', async () => {
		mockStatus.mockResolvedValue(
			statusFixture([
				{ slot: 'primary', subscription_type: 'max-5x' },
				{ slot: 'backup', subscription_type: 'pro' },
				{ slot: 'slot_3', subscription_type: 'pro' },
				{ slot: 'slot_4', subscription_type: 'max-20x' },
			]),
		)

		renderPage()

		expect(await screen.findByTestId('slot-slot_3')).toHaveTextContent('Fallback 3')
		expect(screen.getByTestId('slot-slot_4')).toHaveTextContent('Fallback 4')
		expect(screen.getByTestId('slot-primary')).toHaveTextContent('Primary')
		expect(screen.getByTestId('slot-backup')).toHaveTextContent('Backup')
	})

	it('labels by position, not by slot id, after one in the middle is disconnected', async () => {
		// `backup` was disconnected; the ids that remain keep their names, but
		// what the user sees is "the second one we try".
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary' }, { slot: 'slot_3' }, { slot: 'slot_4' }]),
		)

		renderPage()

		expect(await screen.findByTestId('slot-slot_3')).toHaveTextContent('Backup')
		expect(screen.getByTestId('slot-slot_4')).toHaveTextContent('Fallback 3')
	})

	it('offers no add card once the workspace is at the cap', async () => {
		mockStatus.mockResolvedValue(
			statusFixture(
				Array.from({ length: MAX_SLOTS }, (_, i) => ({
					slot: i === 0 ? 'primary' : i === 1 ? 'backup' : `slot_${i + 1}`,
				})),
			),
		)

		renderPage()

		await screen.findByTestId('slot-primary')
		expect(screen.queryByTestId('slot-add')).not.toBeInTheDocument()
	})

	it('shows the running-on-fallback banner and the unhealthy line on the slot that failed', async () => {
		mockStatus.mockResolvedValue(
			statusFixture(
				[
					{
						slot: 'primary',
						subscription_type: 'max-5x',
						failure_reason: 'quota_exhausted_weekly',
						failure_at: Date.now() - 60_000,
					},
					{ slot: 'backup', subscription_type: 'pro' },
				],
				{ active_slot: 'backup', last_classified_reason: 'quota_exhausted_weekly' },
			),
		)

		renderPage()

		expect(await screen.findByTestId('failover-banner')).toHaveTextContent('Running on backup')
		expect(screen.getByTestId('failover-banner')).toHaveTextContent('weekly usage limit')
		const primary = screen.getByTestId('slot-primary')
		expect(primary).toHaveTextContent('Unhealthy')
		expect(primary).toHaveTextContent('Weekly usage limit reached.')
		expect(screen.getByTestId('slot-backup')).toHaveTextContent('In use')
	})

	it('names the fallback actually in use in the banner', async () => {
		mockStatus.mockResolvedValue(
			statusFixture(
				[
					{ slot: 'primary', failure_reason: 'auth_failed' },
					{ slot: 'backup', failure_reason: 'quota_exhausted_5h' },
					{ slot: 'slot_3' },
				],
				{ active_slot: 'slot_3' },
			),
		)

		renderPage()

		expect(await screen.findByTestId('failover-banner')).toHaveTextContent('Running on fallback 3')
		expect(screen.getByTestId('slot-backup')).toHaveTextContent('5-hour usage limit reached.')
	})

	it('shows reconnect-toned banner copy for auth_failed', async () => {
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary', failure_reason: 'auth_failed' }, { slot: 'backup' }], {
				active_slot: 'backup',
			}),
		)

		renderPage()

		expect(await screen.findByTestId('failover-banner')).toHaveTextContent(
			'needs to be reconnected',
		)
		expect(screen.getByTestId('slot-primary')).toHaveTextContent('Authentication failed')
	})

	it('does not mark the active subscription unhealthy from a stale failure record', async () => {
		// Session start clears the record once a slot serves successfully, but
		// until it does, the slot in use must not read as broken.
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary', failure_reason: 'quota_exhausted_5h' }], {
				active_slot: 'primary',
			}),
		)

		renderPage()

		const primary = await screen.findByTestId('slot-primary')
		expect(primary).toHaveTextContent('Connected')
		expect(primary).not.toHaveTextContent('Unhealthy')
	})

	it('opens the paste flow defaulted to a new slot when adding another subscription', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary' }, { slot: 'backup' }]))

		renderPage()

		await user.click(await screen.findByRole('button', { name: 'Import another subscription' }))
		expect(await screen.findByTestId('paste-flow')).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Add as Fallback 3' })).toHaveAttribute(
			'aria-checked',
			'true',
		)
	})

	it('sends slot=new on import so the credential is appended to the chain', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary' }, { slot: 'backup' }]))
		mockImport.mockResolvedValue({ success: true, slot: 'slot_3', expires_at: 1 })

		renderPage()
		await user.click(await screen.findByRole('button', { name: 'Import another subscription' }))

		const textarea = screen.getByPlaceholderText(/Paste the contents/)
		await user.click(textarea)
		await user.paste(
			JSON.stringify({
				claudeAiOauth: {
					accessToken: 'a',
					refreshToken: 'r',
					expiresAt: 2_000_000_000_000,
					subscriptionType: 'pro',
				},
			}),
		)
		await user.click(screen.getByRole('button', { name: 'Import' }))

		await waitFor(() => expect(mockImport).toHaveBeenCalled())
		const [, payload] = mockImport.mock.calls[0]
		expect(payload.slot).toBe('new')
		expect(payload.accessToken).toBe('a')
	})

	it('offers to replace an existing subscription by its nickname', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary', nickname: 'Work account' }, { slot: 'backup' }]),
		)
		mockImport.mockResolvedValue({ success: true, slot: 'primary', expires_at: 1 })

		renderPage()

		await user.click((await screen.findAllByRole('button', { name: 'Replace' }))[0])
		expect(await screen.findByTestId('paste-flow')).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Replace Work account' })).toHaveAttribute(
			'aria-checked',
			'true',
		)
	})

	it('"Use first" promotes a fallback to the head of the chain', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary' }, { slot: 'backup' }, { slot: 'slot_3' }]),
		)
		mockPromote.mockResolvedValue({ success: true })

		renderPage()

		const fallback = await screen.findByTestId('slot-slot_3')
		await user.click(within(fallback).getByRole('button', { name: /Use first/ }))
		await waitFor(() =>
			expect(mockPromote).toHaveBeenCalledWith(mockWorkspaceWithRole.id, 'slot_3'),
		)
	})

	it('does not offer "Use first" on the subscription already at the head', async () => {
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary' }, { slot: 'backup' }]))

		renderPage()

		const primary = await screen.findByTestId('slot-primary')
		expect(within(primary).queryByRole('button', { name: /Use first/ })).not.toBeInTheDocument()
	})

	it('disconnects the slot the card belongs to', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary' }, { slot: 'backup' }]))
		mockDisconnect.mockResolvedValue({ success: true })

		renderPage()

		const backup = await screen.findByTestId('slot-backup')
		await user.click(within(backup).getByRole('button', { name: /Disconnect/ }))
		await waitFor(() =>
			expect(mockDisconnect).toHaveBeenCalledWith(mockWorkspaceWithRole.id, 'backup'),
		)
	})

	it('saves a trimmed nickname on blur', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary', subscription_type: 'max-5x' }]))
		mockRename.mockResolvedValue({ success: true })

		renderPage()

		const input = await screen.findByTestId('slot-primary-nickname')
		await user.type(input, '  Work account  ')
		await user.tab()

		await waitFor(() =>
			expect(mockRename).toHaveBeenCalledWith(mockWorkspaceWithRole.id, 'primary', 'Work account'),
		)
	})

	it('renames the right slot when several are connected', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(
			statusFixture([{ slot: 'primary' }, { slot: 'backup' }, { slot: 'slot_3' }]),
		)
		mockRename.mockResolvedValue({ success: true })

		renderPage()

		const input = await screen.findByTestId('slot-slot_3-nickname')
		await user.type(input, 'Spare')
		await user.tab()

		await waitFor(() =>
			expect(mockRename).toHaveBeenCalledWith(mockWorkspaceWithRole.id, 'slot_3', 'Spare'),
		)
	})

	it('clears a nickname when blurred with an empty value', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary', nickname: 'Old name' }]))
		mockRename.mockResolvedValue({ success: true })

		renderPage()

		const input = await screen.findByTestId('slot-primary-nickname')
		expect(input).toHaveValue('Old name')
		await user.clear(input)
		await user.tab()

		await waitFor(() =>
			expect(mockRename).toHaveBeenCalledWith(mockWorkspaceWithRole.id, 'primary', ''),
		)
	})

	it('does not call rename when blurred without changing the nickname', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary', nickname: 'Unchanged' }]))

		renderPage()

		const input = await screen.findByTestId('slot-primary-nickname')
		await user.click(input)
		await user.tab()

		expect(mockRename).not.toHaveBeenCalled()
	})

	it('reverts the draft and shows an error when saving the nickname fails', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue(statusFixture([{ slot: 'primary', nickname: 'Old name' }]))
		mockRename.mockRejectedValue(new ApiError(403, 'Not a member of this workspace'))

		renderPage()

		const input = await screen.findByTestId('slot-primary-nickname')
		await user.clear(input)
		await user.type(input, 'New name')
		await user.tab()

		await waitFor(() => expect(mockRename).toHaveBeenCalled())
		await waitFor(() =>
			expect(screen.getByText('Not a member of this workspace')).toBeInTheDocument(),
		)
		expect(input).toHaveValue('Old name')
	})
})
