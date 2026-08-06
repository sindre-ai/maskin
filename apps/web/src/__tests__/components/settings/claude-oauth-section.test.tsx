import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const mockStatus = vi.fn()
const mockImport = vi.fn()
const mockDisconnect = vi.fn()
const mockSwap = vi.fn()

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
			},
		},
	}
})

const mockWorkspaceWithRole = {
	id: 'ws-1',
	name: 'Test Workspace',
	role: 'owner' as const,
	settings: {},
	byollmAllowed: true,
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

describe('Settings > Keys > Claude Subscription', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders empty primary + dashed Add-a-backup card when nothing connected', async () => {
		mockStatus.mockResolvedValue({
			connected: false,
			valid: false,
			slots: {},
			active_slot: 'primary',
		})

		renderPage()

		expect(await screen.findByText('Claude Subscription')).toBeInTheDocument()
		// Primary slot empty copy
		expect(await screen.findByText('No primary connected')).toBeInTheDocument()
		// Backup slot empty copy from T3
		expect(screen.getByText('Add a backup')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Import backup credentials' })).toBeInTheDocument()
	})

	it('renders both connected slots with primary marked In use when healthy', async () => {
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'max-5x', expires_at: Date.now() + 24 * 60 * 60 * 1000 * 10 },
				backup: {
					subscription_type: 'pro',
					expires_at: Date.now() + 24 * 60 * 60 * 1000 * 20,
					fingerprint: 'backup123',
				},
			},
			active_slot: 'primary',
		})

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

	it('shows the Running-on-backup banner and unhealthy primary line when failed over (AC-U3)', async () => {
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'max-5x', expires_at: Date.now() + 1000 },
				backup: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
			},
			active_slot: 'backup',
			last_classified_reason: 'quota_exhausted_weekly',
			last_primary_failure_at: Date.now() - 60_000,
		})

		renderPage()

		expect(await screen.findByTestId('failover-banner')).toHaveTextContent('Running on backup')
		expect(screen.getByTestId('failover-banner')).toHaveTextContent('weekly usage limit')
		const primary = screen.getByTestId('slot-primary')
		expect(primary).toHaveTextContent('Unhealthy')
		expect(primary).toHaveTextContent('Weekly usage limit reached.')
		// In-use chip moves to backup
		const backup = screen.getByTestId('slot-backup')
		expect(backup).toHaveTextContent('In use')
	})

	it('shows reconnect-toned banner copy for auth_failed', async () => {
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
				backup: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
			},
			active_slot: 'backup',
			last_classified_reason: 'auth_failed',
		})

		renderPage()

		expect(await screen.findByTestId('failover-banner')).toHaveTextContent(
			'needs to be reconnected',
		)
		expect(screen.getByTestId('slot-primary')).toHaveTextContent('Authentication failed')
	})

	it('opens the paste flow with Backup pre-selected when clicking Add a backup', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
			},
			active_slot: 'primary',
		})

		renderPage()

		await user.click(await screen.findByRole('button', { name: 'Import backup credentials' }))
		expect(await screen.findByTestId('paste-flow')).toBeInTheDocument()
		const backupRadio = screen.getByRole('radio', { name: /Backup/ })
		expect(backupRadio).toHaveAttribute('aria-checked', 'true')
	})

	it('sends slot=backup on import when Backup is selected (AC-U5)', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
			},
			active_slot: 'primary',
		})
		mockImport.mockResolvedValue({ success: true, slot: 'backup', expires_at: 1 })

		renderPage()
		await user.click(await screen.findByRole('button', { name: 'Import backup credentials' }))

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
		expect(payload.slot).toBe('backup')
		expect(payload.accessToken).toBe('a')
	})

	it('"Swap into primary" on the backup slot triggers swap', async () => {
		const user = userEvent.setup()
		mockStatus.mockResolvedValue({
			connected: true,
			valid: true,
			slots: {
				primary: { subscription_type: 'max-5x', expires_at: Date.now() + 1000 },
				backup: { subscription_type: 'pro', expires_at: Date.now() + 1000 },
			},
			active_slot: 'primary',
		})
		mockSwap.mockResolvedValue({ success: true })

		renderPage()

		await user.click(await screen.findByRole('button', { name: 'Swap into primary' }))
		await waitFor(() => expect(mockSwap).toHaveBeenCalledWith(mockWorkspaceWithRole.id))
	})
})
