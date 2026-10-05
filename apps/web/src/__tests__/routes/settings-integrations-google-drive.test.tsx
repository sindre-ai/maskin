import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

const mockUseIntegrations = vi.fn()
const mockConnect = vi.fn()
const mockNavigate = vi.fn()
const connectState = { isPending: false, isError: false }
const mockFlag = vi.fn<() => boolean>(() => true)

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: () => mockFlag(),
}))

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => mockUseIntegrations(),
	useConnectIntegration: () => ({ mutate: mockConnect, ...connectState }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'actor-priya', name: 'Priya Shah' },
			{ id: 'actor-kai', name: 'Kai Ono' },
		],
	}),
}))

vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({
		title,
		description,
		action,
	}: { title: string; description?: string; action?: React.ReactNode }) => (
		<div>
			<p>{title}</p>
			<p>{description}</p>
			{action}
		</div>
	),
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	ListSkeleton: () => <div data-testid="list-skeleton" />,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations_.google-drive'

const DriveDetailPage = (Route as unknown as { component: React.FC }).component

const googleRow = (email: string, actorId: string, provider = 'gmail') =>
	buildIntegrationResponse({ provider, externalId: email, actorId })

const STAMP = '2026-10-05T10:00:00.000Z'

const driveRow = (email: string, overrides = {}) =>
	buildIntegrationResponse({
		provider: 'google-drive',
		externalId: email,
		grantedScopes: ['openid', DRIVE_SCOPE],
		...overrides,
	})

function setRows(rows: ReturnType<typeof buildIntegrationResponse>[]) {
	mockUseIntegrations.mockReturnValue({ data: rows, isLoading: false })
}

describe('Google Drive detail page', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFlag.mockReturnValue(true)
		connectState.isPending = false
		connectState.isError = false
	})

	it('renders nothing Drive-related when the flag is off', () => {
		mockFlag.mockReturnValue(false)
		setRows([googleRow('priya@acme.test', 'actor-priya')])
		render(<DriveDetailPage />)
		expect(screen.getByText('Google Drive is not available yet')).toBeInTheDocument()
		expect(screen.queryByTestId('drive-detail')).not.toBeInTheDocument()
		expect(mockUseIntegrations).not.toHaveBeenCalled()
	})

	it('shows a skeleton while the integrations load', () => {
		mockUseIntegrations.mockReturnValue({ data: undefined, isLoading: true })
		render(<DriveDetailPage />)
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
	})

	it('scope-add: a human with a Google row and no Drive row gets the banner and a CTA', async () => {
		setRows([
			googleRow('priya@acme.test', 'actor-priya'),
			googleRow('priya@acme.test', 'actor-priya', 'google-meet'),
			googleRow('kai@acme.test', 'actor-kai'),
			driveRow('kai@acme.test'),
		])
		render(<DriveDetailPage />)

		expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'scope-add')
		expect(screen.getByLabelText('Partial')).toBeInTheDocument()
		expect(screen.getByTestId('drive-mline')).toHaveTextContent(
			'2 humans on Google · 1 has Drive · 1 needs scope add',
		)
		const banner = screen.getByRole('status')
		expect(banner).toHaveAttribute('aria-live', 'polite')
		expect(within(banner).getByText('1 human needs to add Drive permissions')).toBeInTheDocument()

		const priya = screen.getByTestId('scope-row-priya@acme.test')
		expect(priya).toHaveAttribute('data-state', 'is-missing')
		expect(within(priya).getByLabelText('Edit & comment on any file, not granted')).toBeVisible()

		await userEvent.click(within(priya).getByRole('button', { name: 'Add Drive permissions →' }))
		expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive' })
		await userEvent.click(within(banner).getByRole('button', { name: 'Grant for all →' }))
		expect(mockConnect).toHaveBeenCalledTimes(2)
	})

	it('connected: every human has Drive, no banner, scope chip granted', () => {
		setRows([
			googleRow('priya@acme.test', 'actor-priya'),
			driveRow('priya@acme.test', { config: { first_tool_call_at: STAMP } }),
			driveRow('kai@acme.test'),
		])
		render(<DriveDetailPage />)

		expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'connected')
		expect(screen.getByLabelText('Connected')).toBeInTheDocument()
		expect(screen.getByTestId('drive-mline')).toHaveTextContent('2 humans connected')
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
		const kai = screen.getByTestId('scope-row-kai@acme.test')
		expect(kai).toHaveAttribute('data-state', 'is-complete')
		expect(within(kai).getByLabelText('Edit & comment on any file, granted')).toBeVisible()
		expect(screen.queryByRole('button', { name: /Add Drive permissions/ })).not.toBeInTheDocument()
	})

	it('needs-reconnect: a Drive row that lost its scope shows the reconnect banner', async () => {
		setRows([
			driveRow('priya@acme.test'),
			driveRow('kai@acme.test', { needsReconnect: true, grantedScopes: ['openid'] }),
		])
		render(<DriveDetailPage />)

		expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'needs-reconnect')
		expect(screen.getByLabelText('Attention')).toBeInTheDocument()
		expect(screen.getByTestId('drive-mline')).toHaveTextContent(
			'2 humans connected · 1 needs reconnect',
		)
		const banner = screen.getByRole('status')
		expect(
			within(banner).getByText('Reconnect Google — your token was invalidated'),
		).toBeInTheDocument()
		const kai = screen.getByTestId('scope-row-kai@acme.test')
		expect(within(kai).getByLabelText('Edit & comment on any file, not granted')).toBeVisible()
		await userEvent.click(within(banner).getByRole('button', { name: 'Reconnect →' }))
		expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive' })
	})

	describe('connect wizard', () => {
		const noGoogleRows = () =>
			setRows([buildIntegrationResponse({ provider: 'slack', externalId: 'T1' })])

		it('a workspace with no Google rows sees the wizard instead of the empty state', async () => {
			noGoogleRows()
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'all-disconnected')
			expect(
				screen.getByRole('heading', { name: 'Connect your Google account for Drive' }),
			).toBeInTheDocument()
			expect(screen.queryByText('Drive is not connected')).not.toBeInTheDocument()
			expect(screen.queryByTestId('drive-first-call')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Continue with Google →' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive' })
		})

		it('loading: the primary button reads Opening Google… and is disabled', () => {
			noGoogleRows()
			connectState.isPending = true
			render(<DriveDetailPage />)

			expect(screen.getByRole('button', { name: 'Opening Google…' })).toBeDisabled()
			expect(screen.getByTestId('drive-connect-wizard')).toHaveAttribute('data-state', 'loading')
		})

		it('error: shows the cancelled-sign-in message and leaves Continue available', () => {
			noGoogleRows()
			connectState.isError = true
			render(<DriveDetailPage />)

			expect(screen.getByRole('alert')).toHaveTextContent(
				'Sign-in was cancelled. Try again when ready.',
			)
			expect(screen.getByRole('button', { name: 'Continue with Google →' })).toBeEnabled()
		})

		it('Cancel returns to the integrations list', async () => {
			noGoogleRows()
			render(<DriveDetailPage />)

			await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
			expect(mockNavigate).toHaveBeenCalledWith(
				expect.objectContaining({
					to: '/$workspaceId/settings/integrations',
					params: { workspaceId: 'ws-1' },
				}),
			)
		})

		it('post-callback success: once the Drive row exists the wizard is gone and the first-call state shows', () => {
			setRows([driveRow('priya@acme.test')])
			render(<DriveDetailPage />)

			expect(screen.queryByTestId('drive-connect-wizard')).not.toBeInTheDocument()
			expect(screen.getByTestId('drive-first-call')).toBeInTheDocument()
		})

		it('flag off: neither the wizard nor the first-call state is reachable', () => {
			mockFlag.mockReturnValue(false)
			noGoogleRows()
			render(<DriveDetailPage />)

			expect(screen.queryByTestId('drive-connect-wizard')).not.toBeInTheDocument()
			expect(screen.queryByTestId('drive-first-call')).not.toBeInTheDocument()
		})
	})

	describe('first-call state', () => {
		it('shows while the Drive row has no first_tool_call_at', () => {
			setRows([driveRow('priya@acme.test', { config: { system_actor_id: 'sys' } })])
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'connected')
			expect(
				screen.getByRole('heading', { name: 'Drive is connected. Point your agents at a file.' }),
			).toBeInTheDocument()
			expect(screen.queryByTestId('scope-list')).not.toBeInTheDocument()
		})

		it('gives way to the connected detail once first_tool_call_at is set', () => {
			setRows([driveRow('priya@acme.test', { config: { first_tool_call_at: STAMP } })])
			render(<DriveDetailPage />)

			expect(screen.queryByTestId('drive-first-call')).not.toBeInTheDocument()
			expect(screen.getByTestId('scope-list')).toBeInTheDocument()
		})

		it('reads only first_tool_call_at: a revoked stamped row does not count', () => {
			setRows([
				driveRow('priya@acme.test'),
				driveRow('old@acme.test', { status: 'revoked', config: { first_tool_call_at: STAMP } }),
			])
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-first-call')).toBeInTheDocument()
		})

		it('does not replace the banners of a variant that still needs action', () => {
			setRows([googleRow('priya@acme.test', 'actor-priya'), driveRow('kai@acme.test')])
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'scope-add')
			expect(screen.queryByTestId('drive-first-call')).not.toBeInTheDocument()
			expect(screen.getByTestId('scope-add-banner')).toBeInTheDocument()
		})
	})

	it('ignores revoked rows: a revoked Drive row reads as no Drive for that human', () => {
		setRows([
			googleRow('priya@acme.test', 'actor-priya'),
			driveRow('priya@acme.test', { status: 'revoked' }),
		])
		render(<DriveDetailPage />)
		expect(screen.getByTestId('scope-row-priya@acme.test')).toHaveAttribute(
			'data-state',
			'is-missing',
		)
	})
})
