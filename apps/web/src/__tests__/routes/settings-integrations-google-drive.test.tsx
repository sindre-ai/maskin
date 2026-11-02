import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildDriveWatch, buildIntegrationResponse } from '../factories'
import { installDialogPolyfill } from '../mocks/dialog'

installDialogPolyfill()

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

const mockUseIntegrations = vi.fn()
const mockConnect = vi.fn()
const mockDriveWatches = vi.fn()
const mockDisconnect = vi.fn()
const mockNavigate = vi.fn()
const mockSearch = vi.fn<() => { oauth?: string }>(() => ({}))
const connectState = { isPending: false, isError: false }
const mockFlag = vi.fn<() => boolean>(() => true)

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockSearch(),
		}),
	}
})

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: () => mockFlag(),
}))

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => mockUseIntegrations(),
	useConnectIntegration: () => ({ mutate: mockConnect, ...connectState }),
	useDriveWatches: () => mockDriveWatches(),
	useStopDriveWatch: () => ({ mutate: vi.fn(), isPending: false }),
	useDisconnectGoogle: () => ({
		mutate: mockDisconnect,
		reset: vi.fn(),
		isPending: false,
		isError: false,
	}),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'actor-priya', name: 'Priya Shah' },
			{ id: 'actor-kai', name: 'Kai Ono' },
			{ id: 'actor-linker', name: 'Linker (Sigrid)' },
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
		mockSearch.mockReturnValue({})
		mockDriveWatches.mockReturnValue({ data: [], isLoading: false, isError: false })
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
		expect(mockDriveWatches).not.toHaveBeenCalled()
		expect(screen.queryByTestId('folder-watches')).not.toBeInTheDocument()
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
			'2 humans on Google · 1 has Drive · 1 needs Drive',
		)
		const banner = screen.getByRole('status')
		expect(banner).toHaveAttribute('aria-live', 'polite')
		expect(within(banner).getByText('1 human needs to add Drive permissions')).toBeInTheDocument()

		const priya = screen.getByTestId('scope-row-priya@acme.test')
		expect(priya).toHaveAttribute('data-state', 'is-missing')
		expect(
			within(priya).getByLabelText('Full access to your Drive files, not granted'),
		).toBeVisible()

		await userEvent.click(within(priya).getByRole('button', { name: 'Add Drive permissions →' }))
		expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive', origin: 'google-drive' })
		await userEvent.click(within(banner).getByRole('button', { name: 'Connect Drive →' }))
		expect(mockConnect).toHaveBeenCalledTimes(2)
	})

	it('avatar initials skip punctuation: "Linker (Sigrid)" is LS, not "L("', () => {
		setRows([googleRow('sigrid@acme.test', 'actor-linker')])
		render(<DriveDetailPage />)
		expect(
			within(screen.getByTestId('scope-row-sigrid@acme.test')).getByText('LS'),
		).toBeInTheDocument()
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
		expect(screen.getByText(/Nothing to configure here beyond who's connected/)).toBeInTheDocument()
		expect(screen.queryByText(/To turn it on for a human/)).not.toBeInTheDocument()
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
		const kai = screen.getByTestId('scope-row-kai@acme.test')
		expect(kai).toHaveAttribute('data-state', 'is-complete')
		expect(within(kai).getByLabelText('Full access to your Drive files, granted')).toBeVisible()
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
		expect(within(kai).getByLabelText('Full access to your Drive files, not granted')).toBeVisible()
		await userEvent.click(within(banner).getByRole('button', { name: 'Reconnect →' }))
		expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive', origin: 'google-drive' })
	})

	describe('cancelled consent outside the wizard', () => {
		const scopeAddRows = () => [
			googleRow('priya@acme.test', 'actor-priya'),
			googleRow('kai@acme.test', 'actor-kai'),
			driveRow('kai@acme.test'),
		]

		it('scope-add: shows the cancel message in an alert until the next connect', async () => {
			setRows(scopeAddRows())
			mockSearch.mockReturnValue({ oauth: 'cancelled' })
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-detail')).toHaveAttribute('data-variant', 'scope-add')
			expect(screen.getByTestId('drive-cancelled-alert')).toHaveTextContent(
				'Sign-in was cancelled. Try again when ready.',
			)
			expect(screen.getByRole('alert')).toBe(screen.getByTestId('drive-cancelled-alert'))

			await userEvent.click(screen.getByRole('button', { name: 'Connect Drive →' }))
			expect(screen.queryByTestId('drive-cancelled-alert')).not.toBeInTheDocument()
		})

		it('shows no alert without the oauth param', () => {
			setRows(scopeAddRows())
			render(<DriveDetailPage />)

			expect(screen.queryByTestId('drive-cancelled-alert')).not.toBeInTheDocument()
		})

		it('flag off: the param is not read and nothing renders', () => {
			mockFlag.mockReturnValue(false)
			setRows(scopeAddRows())
			mockSearch.mockReturnValue({ oauth: 'cancelled' })
			render(<DriveDetailPage />)

			expect(screen.queryByTestId('drive-cancelled-alert')).not.toBeInTheDocument()
			expect(mockNavigate).not.toHaveBeenCalled()
		})
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
			// A workspace that never connected Drive is not at fault: no status pill.
			expect(screen.queryByLabelText('Attention')).not.toBeInTheDocument()
			expect(screen.queryByTestId('drive-first-call')).not.toBeInTheDocument()

			await userEvent.click(screen.getByRole('button', { name: 'Continue with Google →' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive', origin: 'google-drive' })
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

		it('cancelled consent: shows the message, strips the param, Continue works again', async () => {
			noGoogleRows()
			mockSearch.mockReturnValue({ oauth: 'cancelled' })
			render(<DriveDetailPage />)

			expect(screen.getByTestId('drive-connect-wizard')).toHaveAttribute('data-state', 'error')
			expect(screen.getByRole('alert')).toHaveTextContent(
				'Sign-in was cancelled. Try again when ready.',
			)
			expect(mockNavigate).toHaveBeenCalledWith(
				expect.objectContaining({
					to: '/$workspaceId/settings/integrations/google-drive',
					search: {},
					replace: true,
				}),
			)

			await userEvent.click(screen.getByRole('button', { name: 'Continue with Google →' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'google-drive', origin: 'google-drive' })
			expect(screen.getByTestId('drive-connect-wizard')).toHaveAttribute('data-state', 'default')
		})

		it('no oauth param: no cancel message and no navigation', () => {
			noGoogleRows()
			render(<DriveDetailPage />)

			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			expect(mockNavigate).not.toHaveBeenCalled()
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

	it('folder watches: lists seeded watches under the human the Drive row belongs to', () => {
		setRows([
			googleRow('priya@acme.test', 'actor-priya'),
			driveRow('priya@acme.test', { config: { first_tool_call_at: STAMP } }),
		])
		mockDriveWatches.mockReturnValue({
			data: [
				buildDriveWatch({ folderId: 'f-rec', name: 'Meet Recordings', account: 'priya@acme.test' }),
				buildDriveWatch({ folderId: 'f-new', name: 'Brief drop', account: 'newcomer@acme.test' }),
			],
			isLoading: false,
			isError: false,
		})
		render(<DriveDetailPage />)

		const section = screen.getByTestId('folder-watches')
		expect(within(section).getAllByRole('listitem')).toHaveLength(2)
		// Named through the page's own human naming: actor name, else the email local part.
		expect(
			within(screen.getByTestId('folder-watch-f-rec')).getByTestId('folder-watch-meta'),
		).toHaveTextContent('Priya Shah')
		expect(
			within(screen.getByTestId('folder-watch-f-new')).getByTestId('folder-watch-meta'),
		).toHaveTextContent('newcomer')
	})

	it('folder watches: no watches shows the empty state on the connected page', () => {
		setRows([driveRow('priya@acme.test', { config: { first_tool_call_at: STAMP } })])
		render(<DriveDetailPage />)
		expect(screen.getByText('No folders are being watched')).toBeInTheDocument()
	})

	it('folder watches: not rendered, and not fetched, when no Drive is connected', () => {
		setRows([buildIntegrationResponse({ provider: 'slack', externalId: 'T1' })])
		render(<DriveDetailPage />)
		expect(screen.queryByTestId('folder-watches')).not.toBeInTheDocument()
		expect(mockDriveWatches).not.toHaveBeenCalled()
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

describe('Google Drive detail page, disconnect flow', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFlag.mockReturnValue(true)
	})

	const kaiRows = () => [
		googleRow('kai@acme.test', 'actor-kai', 'gmail'),
		googleRow('kai@acme.test', 'actor-kai', 'google-calendar'),
		googleRow('kai@acme.test', 'actor-kai', 'google-meet'),
		driveRow('kai@acme.test', { actorId: 'actor-kai', config: { first_tool_call_at: STAMP } }),
	]

	it('flag off: the page is unreachable, so is the modal', () => {
		mockFlag.mockReturnValue(false)
		setRows(kaiRows())
		render(<DriveDetailPage />)
		expect(screen.queryByRole('button', { name: 'Disconnect Drive' })).not.toBeInTheDocument()
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('only a human with a Drive row gets a Disconnect Drive action', () => {
		setRows([googleRow('priya@acme.test', 'actor-priya'), ...kaiRows()])
		render(<DriveDetailPage />)
		const priya = screen.getByTestId('scope-row-priya@acme.test')
		const kai = screen.getByTestId('scope-row-kai@acme.test')
		expect(
			within(priya).queryByRole('button', { name: 'Disconnect Drive' }),
		).not.toBeInTheDocument()
		expect(within(kai).getByRole('button', { name: 'Disconnect Drive' })).toBeInTheDocument()
	})

	it('opens a dialog titled for the human with Drive only preselected', async () => {
		setRows(kaiRows())
		render(<DriveDetailPage />)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Disconnect Drive' }))

		const dialog = screen.getByRole('dialog', { name: 'Disconnect Drive for Kai Ono?' })
		expect(within(dialog).getByRole('radiogroup')).toBeInTheDocument()
		expect(within(dialog).getAllByRole('radio')).toHaveLength(3)
		expect(within(dialog).getByRole('radio', { name: /Just disconnect Drive/ })).toBeChecked()
		expect(within(dialog).getByTestId('disconnect-stays-callout')).toHaveTextContent(
			'Still connected: Gmail, Calendar and Meet.',
		)
	})

	it.each([
		[
			'Disconnect Drive and Meet',
			'drive-meet',
			'Disconnect Drive + Meet',
			'Still connected: Gmail and Calendar.',
		],
		[
			"Disconnect Kai Ono's whole Google account",
			'google',
			'Disconnect Google account',
			'Nothing else stays connected for this Google account.',
		],
	])(
		'radio %s: label becomes %s and confirm sends scope %s',
		async (radio, scope, label, stays) => {
			setRows(kaiRows())
			render(<DriveDetailPage />)
			await userEvent.click(screen.getByRole('button', { name: 'Disconnect Drive' }))
			const dialog = screen.getByRole('dialog')

			await userEvent.click(within(dialog).getByRole('radio', { name: new RegExp(radio) }))
			expect(within(dialog).getByRole('button', { name: label })).toBeInTheDocument()
			expect(within(dialog).getByTestId('disconnect-stays-callout')).toHaveTextContent(stays)

			await userEvent.click(within(dialog).getByRole('button', { name: label }))
			expect(mockDisconnect).toHaveBeenCalledWith(
				{ email: 'kai@acme.test', scope },
				expect.objectContaining({ onSuccess: expect.any(Function) }),
			)
		},
	)

	it('after success the modal closes and the callout names what remains from the rows', async () => {
		setRows(kaiRows())
		mockDisconnect.mockImplementation((_input, opts) => opts.onSuccess())
		render(<DriveDetailPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Disconnect Drive' }))

		await userEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect Drive' }),
		)

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
		const callout = screen.getByRole('status')
		expect(callout).toBe(screen.getByTestId('post-disconnect-callout'))
		expect(callout).toHaveAttribute('aria-live', 'polite')
		expect(callout).toHaveTextContent(
			'Drive disconnected for Kai Ono. Gmail, Calendar and Meet are still connected.',
		)
	})

	it('names only the services that actually remain when the human had no Meet row', async () => {
		setRows([
			googleRow('kai@acme.test', 'actor-kai', 'gmail'),
			driveRow('kai@acme.test', { actorId: 'actor-kai', config: { first_tool_call_at: STAMP } }),
		])
		mockDisconnect.mockImplementation((_input, opts) => opts.onSuccess())
		render(<DriveDetailPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Disconnect Drive' }))
		await userEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect Drive' }),
		)
		expect(screen.getByTestId('post-disconnect-callout')).toHaveTextContent(
			'Drive disconnected for Kai Ono. Gmail is still connected.',
		)
	})

	it('Cancel closes the modal without calling the endpoint', async () => {
		setRows(kaiRows())
		render(<DriveDetailPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Disconnect Drive' }))
		await userEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
		)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
		expect(mockDisconnect).not.toHaveBeenCalled()
	})
})
