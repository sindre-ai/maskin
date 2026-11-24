import type { GithubPendingSelection, LinkableGithubInstallation } from '@/lib/api'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockUseIntegrations = vi.fn()
const mockUseProviders = vi.fn()
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockNavigate = vi.fn()

/** Search params the route sees. The page reads `?select_github=<id>` to decide
 *  whether to open the post-authorization org picker. */
const mockSearch = vi.fn<() => Record<string, string | undefined>>(() => ({}))

// The Tools section has its own tests (components/integrations/tools-section.test.tsx).
vi.mock('@/components/integrations/tools-section', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/components/integrations/tools-section')>()),
	ToolsSection: () => null,
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockSearch(),
			fullPath: '/_authed/$workspaceId/settings/integrations',
		}),
	}
})

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

/** The LinkedIn add-on copy branches on the workspace plan, so the page reads
 *  billing usage. Default to a non-enterprise plan — the paid "$49/month" copy
 *  — and let the enterprise tests override it. */
const mockUseBillingUsage = vi.fn<() => { data: { plan: string } | undefined }>(() => ({
	data: { plan: 'free' },
}))

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: () => mockUseBillingUsage(),
}))

const mockUseLinkableGithub = vi.fn<
	() => { data: LinkableGithubInstallation[]; isLoading: boolean }
>(() => ({ data: [], isLoading: false }))
const mockLinkGithub = vi.fn()

const mockUseGithubPendingSelection = vi.fn<
	() => {
		data: GithubPendingSelection | undefined
		isLoading: boolean
	}
>(() => ({ data: undefined, isLoading: false }))
const mockSelectGithub = vi.fn()

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: (...args: unknown[]) => mockUseIntegrations(...args),
	useProviders: () => mockUseProviders(),
	useConnectIntegration: () => ({ mutate: mockConnect, isPending: false }),
	useDisconnectIntegration: () => ({ mutate: mockDisconnect, isPending: false }),
	useCompleteIntegration: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	// Default: nothing bindable, so the "Add existing" affordance stays hidden.
	// Tests that exercise it override mockUseLinkableGithub.
	useLinkableGithubInstallations: () => mockUseLinkableGithub(),
	useLinkGithubInstallation: () => ({ mutate: mockLinkGithub, isPending: false }),
	// Default: no selection pending, so the post-authorization picker stays shut.
	useGithubPendingSelection: () => mockUseGithubPendingSelection(),
	useSelectGithubInstallation: () => ({ mutate: mockSelectGithub, isPending: false }),
	// The Resend connect dialog is always mounted (closed); it only has to render.
	useResendDnsPrecheck: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	// Agent access has its own tests; here it only has to render.
	useSetAgentGrant: () => ({ mutate: vi.fn(), isPending: false }),
	useRemoveAgentGrant: () => ({ mutate: vi.fn(), isPending: false }),
	useRemoveChatGrant: () => ({ mutate: vi.fn(), isPending: false }),
	useSetDefaultAgentAccess: () => ({ mutate: vi.fn(), isPending: false }),
}))

/** LinkedIn installs are per-member, so the grouped row resolves who connected
 *  each one: the caller's own id from useAuth, the display names from useActors. */
const mockUseAuth = vi.fn<() => { actor: { id: string } | null }>(() => ({
	actor: { id: 'actor-1' },
}))

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => mockUseAuth(),
}))

const mockUseActors = vi.fn<() => { data: { id: string; name: string }[] }>(() => ({
	data: [
		{ id: 'actor-1', name: 'Magnus' },
		{ id: 'actor-2', name: 'Colleague' },
	],
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({
		title,
		description,
		action,
	}: { title: string; description?: string; action?: React.ReactNode }) => (
		<div>
			<div>{title}</div>
			{description && <div>{description}</div>}
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

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: React.FC }).component

/** The full list of tools nobody has connected. Popular and New repeat some of them on purpose. */
function allIntegrations() {
	return within(screen.getByRole('region', { name: 'All integrations' }))
}

/** A connected provider is a collapsed card on the Connected tab; its actions sit inside. */
async function expandCard(name: string) {
	await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }))
}

describe('IntegrationsPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// clearAllMocks keeps implementations, so reset the ones whose return
		// value a single test overrides — otherwise ordering leaks state.
		mockSearch.mockReturnValue({})
		mockUseGithubPendingSelection.mockReturnValue({ data: undefined, isLoading: false })
		mockUseBillingUsage.mockReturnValue({ data: { plan: 'free' } })
		mockUseAuth.mockReturnValue({ actor: { id: 'actor-1' } })
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'actor-1', name: 'Magnus' },
				{ id: 'actor-2', name: 'Colleague' },
			],
		})
	})

	it('shows loading state', () => {
		mockUseIntegrations.mockReturnValue({ data: undefined, isLoading: true })
		mockUseProviders.mockReturnValue({ data: undefined, isLoading: true })
		render(<IntegrationsPage />)
		expect(screen.getByTestId('list-skeleton')).toBeInTheDocument()
	})

	it('shows empty state when no providers available', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({ data: [], isLoading: false })
		render(<IntegrationsPage />)
		expect(screen.getByText('No providers available')).toBeInTheDocument()
	})

	it('renders provider list with display names', async () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] },
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [{ type: 'push' }] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(allIntegrations().getByText('Slack')).toBeInTheDocument()
		expect(allIntegrations().getByText('GitHub')).toBeInTheDocument()
	})

	it('shows Connect for disconnected and Disconnect for connected providers', async () => {
		const integration = buildIntegrationResponse({
			provider: 'slack',
			status: 'active',
		})
		mockUseIntegrations.mockReturnValue({ data: [integration], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] },
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		await expandCard('Slack')
		expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
		expect(allIntegrations().getByRole('button', { name: 'Connect' })).toBeInTheDocument()
	})

	describe('Skjald connect dialog', () => {
		const skjaldProvider = {
			name: 'skjald',
			displayName: 'Skjald',
			authType: 'manual',
			events: [{ type: 'meeting.created' }],
		}

		async function renderSkjald() {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [skjaldProvider], isLoading: false })
			render(<IntegrationsPage />)
		}

		it('tells the person where to tap in the Skjald app, without creating a webhook', async () => {
			const user = userEvent.setup()
			await renderSkjald()

			await user.click(screen.getByRole('button', { name: 'Connect' }))

			const dialog = screen.getByRole('dialog')
			expect(
				within(dialog).getByText('Open Skjald and go to Settings → Send to.'),
			).toBeInTheDocument()
			expect(within(dialog).getByText('Tap Connect with Maskin.')).toBeInTheDocument()
			expect(within(dialog).queryByText('Webhook URL')).not.toBeInTheDocument()
			expect(mockConnect).not.toHaveBeenCalled()
		})

		it('closes on Done', async () => {
			const user = userEvent.setup()
			await renderSkjald()

			await user.click(screen.getByRole('button', { name: 'Connect' }))
			await user.click(screen.getByRole('button', { name: 'Done' }))

			await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
			expect(mockConnect).not.toHaveBeenCalled()
		})

		it('keeps the URL-and-secret flow behind Set up manually', async () => {
			const user = userEvent.setup()
			await renderSkjald()

			await user.click(screen.getByRole('button', { name: 'Connect' }))
			await user.click(screen.getByRole('button', { name: 'Set up manually' }))

			expect(mockConnect).toHaveBeenCalledWith(
				{ provider: 'skjald' },
				expect.objectContaining({ onSuccess: expect.any(Function) }),
			)
			// Nothing about the URL until the connect call comes back.
			expect(screen.queryByText('Webhook URL')).not.toBeInTheDocument()

			const [, options] = mockConnect.mock.calls[0]
			act(() => {
				options.onSuccess({
					webhook_url: 'https://maskin.test/api/webhooks/skjald/tok',
					integration_id: 'int-1',
				})
			})

			expect(await screen.findByText('Webhook URL')).toBeInTheDocument()
			expect(screen.getByText('https://maskin.test/api/webhooks/skjald/tok')).toBeInTheDocument()
		})
	})

	it('keeps the api key dialog open until connect succeeds', async () => {
		const user = userEvent.setup()
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [{ name: 'posthog', displayName: 'PostHog', authType: 'api_key', events: [] }],
			isLoading: false,
		})
		render(<IntegrationsPage />)

		await user.click(screen.getByRole('button', { name: 'Connect' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()

		await user.type(screen.getByLabelText('API key'), 'phx_test_key')
		expect(screen.getByDisplayValue('phx_test_key')).toBeInTheDocument()

		const connectButton = screen.getByRole('button', { name: 'Connect' })
		await user.click(connectButton)

		expect(mockConnect).toHaveBeenCalledWith(
			{ provider: 'posthog', apiKey: 'phx_test_key' },
			expect.objectContaining({
				onSuccess: expect.any(Function),
			}),
		)
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByDisplayValue('phx_test_key')).toBeInTheDocument()

		const [, options] = mockConnect.mock.calls[0]
		await act(async () => {
			options.onSuccess?.()
		})

		await waitFor(() => {
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
		})
		expect(screen.queryByDisplayValue('phx_test_key')).not.toBeInTheDocument()
	})

	describe('grouped GitHub installations', () => {
		const githubProvider = { name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [] }

		const twoInstallations = [
			buildIntegrationResponse({
				id: 'gh-1',
				provider: 'github',
				status: 'active',
				externalId: '111',
				config: { owner_login: 'vaerksted-ai' },
			}),
			buildIntegrationResponse({
				id: 'gh-2',
				provider: 'github',
				status: 'active',
				externalId: '222',
				config: { owner_login: 'sindre-ai' },
			}),
		]

		it('renders one header showing the count, with nested rows for each installation', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /GitHub · 2/ }))

			expect(screen.getByText('GitHub · 2')).toBeInTheDocument()
			expect(screen.getByText('vaerksted-ai')).toBeInTheDocument()
			expect(screen.getByText('sindre-ai')).toBeInTheDocument()
			// Two nested disconnect buttons + no top-level disconnect on the header
			expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(2)
		})

		it('starts collapsed even when more than one installation exists', () => {
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const header = screen.getByRole('button', { name: /GitHub · 2/ })
			expect(header).toHaveAttribute('aria-expanded', 'false')
			expect(
				screen.queryByRole('button', { name: /Connect another installation/ }),
			).not.toBeInTheDocument()
		})

		it('defaults to collapsed when only one installation exists', () => {
			mockUseIntegrations.mockReturnValue({
				data: [twoInstallations[0]],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const header = screen.getByRole('button', { name: /GitHub · 1/ })
			expect(header).toHaveAttribute('aria-expanded', 'false')
			expect(screen.queryByText('vaerksted-ai')).not.toBeInTheDocument()
			expect(
				screen.queryByRole('button', { name: /Connect another installation/ }),
			).not.toBeInTheDocument()
		})

		it('toggles the nested list when the header is clicked — no chevron, header IS the toggle', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const header = screen.getByRole('button', { name: /GitHub · 2/ })
			await user.click(header)
			expect(header).toHaveAttribute('aria-expanded', 'true')
			expect(screen.getByText('vaerksted-ai')).toBeInTheDocument()

			await user.click(header)
			expect(header).toHaveAttribute('aria-expanded', 'false')
			expect(screen.queryByText('vaerksted-ai')).not.toBeInTheDocument()
		})

		it('disconnects only the targeted installation when a nested Disconnect is clicked', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /GitHub · 2/ }))

			const sindreRow = screen.getByText('sindre-ai').closest('div.flex') as HTMLElement
			await user.click(within(sindreRow).getByRole('button', { name: 'Disconnect' }))
			expect(mockDisconnect).not.toHaveBeenCalled()

			// The question is on the row, not a dialog.
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
			const confirm = screen.getByRole('group', { name: 'Disconnect GitHub (sindre-ai)' })
			expect(within(confirm).getByText(/Agents lose access/)).toBeInTheDocument()
			await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }))

			expect(mockDisconnect).toHaveBeenCalledTimes(1)
			expect(mockDisconnect).toHaveBeenCalledWith('gh-2', expect.anything())
		})

		it('"Add another" triggers the connect flow for github', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /GitHub · 2/ }))

			await user.click(screen.getByRole('button', { name: /Connect another installation/ }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'github' })
		})

		it('marks each installation Active, or Reconnect needed when its token lacks a new scope', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({
				data: [
					twoInstallations[0],
					{ ...twoInstallations[1], needsReconnect: true, missingScopes: ['workflow'] },
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /GitHub · 2/ }))

			expect(screen.getAllByLabelText('Active')).toHaveLength(1)
			expect(screen.getAllByLabelText('Reconnect needed')).toHaveLength(1)

			// Reconnect runs the provider's normal sign-in, which updates the row in place.
			await user.click(screen.getByRole('button', { name: 'Reconnect' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'github' })
		})

		it('falls back to the single-row Connect UI when github has no active installations', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			expect(screen.queryByText(/GitHub · /)).not.toBeInTheDocument()
			expect(allIntegrations().getByRole('button', { name: 'Connect' })).toBeInTheDocument()
		})

		it('does not group non-github providers even when multiple integrations exist for them', async () => {
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({ id: 's1', provider: 'slack', status: 'active' }),
					buildIntegrationResponse({ id: 's2', provider: 'slack', status: 'active' }),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({
				data: [{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }],
				isLoading: false,
			})
			render(<IntegrationsPage />)
			await expandCard('Slack')

			expect(screen.queryByText(/Slack · /)).not.toBeInTheDocument()
			expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(1)
		})
	})

	describe('google calendar detail card', () => {
		const googleCalendarProvider = {
			name: 'google-calendar',
			displayName: 'Google Calendar',
			authType: 'oauth2',
			events: [],
			externalIdDisplay: 'email' as const,
		}

		it('shows the connected Google account email and a Disconnect button when connected', async () => {
			const user = userEvent.setup()
			const integration = buildIntegrationResponse({
				id: 'gc-1',
				provider: 'google-calendar',
				status: 'active',
				externalId: 'magnus@example.com',
			})
			mockUseIntegrations.mockReturnValue({ data: [integration], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [googleCalendarProvider], isLoading: false })

			render(<IntegrationsPage />)
			await expandCard('Google Calendar')

			expect(screen.getByText('Google Calendar')).toBeInTheDocument()
			expect(screen.getByText('Connected as magnus@example.com')).toBeInTheDocument()
			expect(screen.queryByText(/Installation /)).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Disconnect' }))
			// Nothing is disconnected until the person confirms, and the question sits on the row.
			expect(mockDisconnect).not.toHaveBeenCalled()
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
			expect(
				screen.getByText('Disconnect Google Calendar? Agents lose access.'),
			).toBeInTheDocument()

			await user.click(
				within(screen.getByRole('group', { name: 'Disconnect Google Calendar' })).getByRole(
					'button',
					{ name: 'Disconnect' },
				),
			)
			expect(mockDisconnect).toHaveBeenCalledTimes(1)
			expect(mockDisconnect).toHaveBeenCalledWith('gc-1', expect.anything())
		})

		it('keeps the connection when the person presses Keep', async () => {
			const user = userEvent.setup()
			const integration = buildIntegrationResponse({
				id: 'gc-1',
				provider: 'google-calendar',
				status: 'active',
				externalId: 'magnus@example.com',
			})
			mockUseIntegrations.mockReturnValue({ data: [integration], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [googleCalendarProvider], isLoading: false })

			render(<IntegrationsPage />)
			await expandCard('Google Calendar')

			await user.click(screen.getByRole('button', { name: 'Disconnect' }))
			await user.click(screen.getByRole('button', { name: 'Keep' }))

			expect(screen.queryByText(/Agents lose access/)).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Disconnect' })).toHaveFocus()
			expect(mockDisconnect).not.toHaveBeenCalled()
		})

		it('shows the category, not an event count, when a tool has no description', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [googleCalendarProvider], isLoading: false })

			render(<IntegrationsPage />)

			// Popular shows the category under a tool with no written description.
			expect(
				within(screen.getByRole('region', { name: 'Popular' })).getByText('Email & calendar'),
			).toBeInTheDocument()
			expect(screen.queryByText(/event types available/)).not.toBeInTheDocument()
		})
	})

	describe('google drive provider card', () => {
		const googleDriveProvider = {
			name: 'google-drive',
			displayName: 'Google Drive',
			authType: 'oauth2',
			events: [],
			externalIdDisplay: 'email' as const,
		}

		it('shows the Drive card next to the other OAuth providers', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [
					googleDriveProvider,
					{ ...googleDriveProvider, name: 'gmail', displayName: 'Gmail' },
				],
				isLoading: false,
			})

			render(<IntegrationsPage />)

			expect(allIntegrations().getByText('Google Drive')).toBeInTheDocument()
			expect(allIntegrations().getByText('Gmail')).toBeInTheDocument()
			expect(allIntegrations().getAllByRole('button', { name: 'Connect' })).toHaveLength(2)
		})

		it('shows the New pill, description, meta line and a Details link on the Drive card', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [googleDriveProvider], isLoading: false })

			render(<IntegrationsPage />)

			expect(allIntegrations().getByLabelText('New')).toBeInTheDocument()
			expect(
				allIntegrations().getByText(
					'File bytes, Docs, Sheets, search, folder watch, write, comments.',
				),
			).toBeInTheDocument()
			expect(allIntegrations().getByText('Free · Piggybacks on Google auth')).toBeInTheDocument()
			expect(allIntegrations().getByRole('link', { name: 'Details' })).toBeInTheDocument()
		})

		it('keeps the Details link on a connected Drive card', async () => {
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({
						id: 'gd-1',
						provider: 'google-drive',
						status: 'active',
						externalId: 'kai@acme.test',
					}),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [googleDriveProvider], isLoading: false })

			render(<IntegrationsPage />)
			await expandCard('Google Drive')

			expect(screen.getByRole('link', { name: 'Details' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
		})

		it('does not put Drive extras on other providers', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [{ ...googleDriveProvider, name: 'gmail', displayName: 'Gmail' }],
				isLoading: false,
			})

			render(<IntegrationsPage />)

			expect(screen.queryByLabelText('New')).not.toBeInTheDocument()
			expect(screen.queryByRole('link', { name: 'Details' })).not.toBeInTheDocument()
		})
	})

	describe('gmail accounts', () => {
		const gmailProvider = {
			name: 'gmail',
			displayName: 'Gmail',
			authType: 'oauth2',
			events: [{ entityType: 'gmail.message', actions: ['received'], label: 'Email' }],
			externalIdDisplay: 'email' as const,
		}
		const gmailRow = (id: string, externalId: string) =>
			buildIntegrationResponse({ id, provider: 'gmail', status: 'active', externalId })

		it('lists one connected account by its address, not as an installation', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({
				data: [gmailRow('gm-1', 'user@gmail.com')],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [gmailProvider], isLoading: false })

			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /Gmail · 1/ }))

			expect(screen.getByText('1 connected account')).toBeInTheDocument()
			expect(screen.getByText('user@gmail.com')).toBeInTheDocument()
			expect(screen.queryByText(/Installation /)).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Connect another account' })).toBeInTheDocument()
		})

		it('shows every connected account by address, each with its own agent access and Disconnect', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({
				data: [
					gmailRow('gm-1', 'sebastian@meshfirm.com'),
					gmailRow('gm-2', 'krumhausen@gmail.com'),
					gmailRow('gm-3', 'growth@vaerksted.ai'),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [gmailProvider], isLoading: false })

			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /Gmail · 3/ }))

			expect(screen.getByText('3 connected accounts')).toBeInTheDocument()
			expect(screen.getByText('sebastian@meshfirm.com')).toBeInTheDocument()
			expect(screen.getByText('krumhausen@gmail.com')).toBeInTheDocument()
			expect(screen.getByText('growth@vaerksted.ai')).toBeInTheDocument()
			expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(3)

			const secondRow = screen.getByText('krumhausen@gmail.com').closest('div.flex') as HTMLElement
			await user.click(within(secondRow).getByRole('button', { name: 'Disconnect' }))
			const confirm = screen.getByRole('group', { name: 'Disconnect Gmail (krumhausen@gmail.com)' })
			await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }))
			expect(mockDisconnect).toHaveBeenCalledWith('gm-2', expect.anything())
		})

		it('"Connect another account" starts the Google sign-in for gmail', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({
				data: [gmailRow('gm-1', 'user@gmail.com')],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [gmailProvider], isLoading: false })

			render(<IntegrationsPage />)
			await user.click(screen.getByRole('button', { name: /Gmail · 1/ }))
			await user.click(screen.getByRole('button', { name: 'Connect another account' }))

			expect(mockConnect).toHaveBeenCalledWith({ provider: 'gmail' })
		})

		it('keeps the plain Connect button while no account is connected', async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [gmailProvider], isLoading: false })

			render(<IntegrationsPage />)

			expect(screen.queryByText(/Gmail · /)).not.toBeInTheDocument()
			expect(allIntegrations().getByRole('button', { name: 'Connect' })).toBeInTheDocument()
		})
	})

	it('offers "Add existing" only when a GitHub installation is bindable', async () => {
		// GitHub installs its App once per org, so a workspace that wants an org
		// already connected elsewhere binds the existing installation instead of
		// running the install flow.
		const user = userEvent.setup()
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [{ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom', events: [] }],
			isLoading: false,
		})
		mockUseLinkableGithub.mockReturnValue({
			data: [{ installationId: '4242', ownerLogin: 'acme-org', alreadyLinked: false }],
			isLoading: false,
		})
		render(<IntegrationsPage />)

		await user.click(allIntegrations().getByRole('button', { name: /Add existing/ }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText('acme-org')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Add' }))
		expect(mockLinkGithub).toHaveBeenCalledWith('4242', expect.anything())
	})

	it('hides "Add existing" when every reachable installation is already here', async () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [{ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom', events: [] }],
			isLoading: false,
		})
		mockUseLinkableGithub.mockReturnValue({
			data: [{ installationId: '99', ownerLogin: 'acme-org', alreadyLinked: true }],
			isLoading: false,
		})
		render(<IntegrationsPage />)

		expect(screen.queryByRole('button', { name: /Add existing/ })).not.toBeInTheDocument()
	})

	// Post-authorization org picker. GitHub installs its App once per org, so
	// Connect goes through user authorization; when the authorizing user can
	// reach several installations the callback sends them back here with
	// ?select_github=<pending row id> to choose one.
	describe('choosing an org after GitHub user authorization', () => {
		const PENDING_ID = '00000000-0000-4000-8000-0000000000aa'

		function seedPageWithSelection() {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [{ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom', events: [] }],
				isLoading: false,
			})
			mockSearch.mockReturnValue({ select_github: PENDING_ID })
			mockUseGithubPendingSelection.mockReturnValue({
				data: {
					integrationId: PENDING_ID,
					installations: [
						{ installationId: '146523409', ownerLogin: 'sindre-ai' },
						{ installationId: '154364583', ownerLogin: 'vaerksted-ai' },
					],
				},
				isLoading: false,
			})
		}

		it('lists every authorized organization when a selection is pending', () => {
			seedPageWithSelection()
			render(<IntegrationsPage />)

			expect(screen.getByText('Choose a GitHub organization')).toBeInTheDocument()
			expect(screen.getByText('sindre-ai')).toBeInTheDocument()
			expect(screen.getByText('vaerksted-ai')).toBeInTheDocument()
		})

		it('submits the chosen installation with the pending row id', async () => {
			seedPageWithSelection()
			render(<IntegrationsPage />)

			const connectButtons = screen.getAllByRole('button', { name: 'Connect' })
			await userEvent.click(connectButtons[0])

			expect(mockSelectGithub).toHaveBeenCalledWith(
				{ integrationId: PENDING_ID, installationId: '146523409' },
				expect.anything(),
			)
		})

		it('stays shut when no selection is pending', () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [{ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom', events: [] }],
				isLoading: false,
			})
			mockSearch.mockReturnValue({})
			render(<IntegrationsPage />)

			expect(screen.queryByText('Choose a GitHub organization')).not.toBeInTheDocument()
		})
	})

	// A failed connect redirects back with ?error=<code>. The page turns the code
	// into one plain dismissible alert and removes the param from the URL.
	describe('failed connect alert', () => {
		const seed = (error: string) => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }],
				isLoading: false,
			})
			mockSearch.mockReturnValue({ error })
		}

		it.each([
			['token_exchange_failed', /didn't accept the sign-in/i],
			['people_id_fetch_failed', /account details from Google/i],
			['post_install_failed', /setting up the connection failed/i],
		])('shows plain copy for %s', (code, copy) => {
			seed(code)
			render(<IntegrationsPage />)

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent(copy)
			expect(alert).not.toHaveTextContent(code)
		})

		it('shows a generic line for an unknown code', () => {
			seed('something_new')
			render(<IntegrationsPage />)

			const alert = screen.getByRole('alert')
			expect(alert).toHaveTextContent("Connecting didn't work. Try again.")
			expect(alert).not.toHaveTextContent('something_new')
		})

		it('removes the error param from the URL once the alert shows', () => {
			seed('token_exchange_failed')
			render(<IntegrationsPage />)

			expect(mockNavigate).toHaveBeenCalledTimes(1)
			const { search, replace } = mockNavigate.mock.calls[0][0]
			expect(replace).toBe(true)
			expect(search({ error: 'token_exchange_failed', return_to: '/x' })).toEqual({
				error: undefined,
				return_to: '/x',
			})
		})

		it('hides the alert when dismissed', async () => {
			seed('token_exchange_failed')
			render(<IntegrationsPage />)

			await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
		})

		it('shows no alert when there is no error param', () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [], isLoading: false })
			render(<IntegrationsPage />)

			expect(screen.queryByRole('alert')).not.toBeInTheDocument()
			expect(mockNavigate).not.toHaveBeenCalled()
		})
	})

	// Slack agents need channel history to dedupe threads and load context, so
	// when the stored token is missing one of those scopes the card swaps the
	// generic "grant N permissions" copy for a Slack-specific one that names
	// what reconnecting unlocks. The Reconnect button re-triggers the same
	// OAuth flow an operator would hit from the reactive withScopeHint error.
	describe('slack reconnect-required label', () => {
		const slackProvider = { name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }

		it('renders the Slack-specific label when a history scope is missing', async () => {
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({
						provider: 'slack',
						status: 'active',
						missingScopes: ['channels:history'],
						needsReconnect: true,
					}),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [slackProvider], isLoading: false })
			render(<IntegrationsPage />)
			await expandCard('Slack')

			expect(
				screen.getByText(
					'Reconnect required — Slack agents need history access to read channel backlog.',
				),
			).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
		})

		it('hides the Reconnect button and Slack-specific label when all three history scopes are granted', async () => {
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({
						provider: 'slack',
						status: 'active',
						missingScopes: [],
						needsReconnect: false,
					}),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [slackProvider], isLoading: false })
			render(<IntegrationsPage />)
			await expandCard('Slack')

			expect(screen.getByText('Channels and triggers')).toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
			expect(
				screen.queryByText(/Slack agents need history access to read channel backlog/),
			).not.toBeInTheDocument()
		})

		it('clicking Reconnect re-triggers the OAuth flow for Slack', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({
						provider: 'slack',
						status: 'active',
						missingScopes: ['channels:history', 'groups:history', 'mpim:history'],
						needsReconnect: true,
					}),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [slackProvider], isLoading: false })
			render(<IntegrationsPage />)
			await expandCard('Slack')

			await user.click(screen.getByRole('button', { name: 'Reconnect' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'slack' })
		})

		it('falls through to the generic copy when Slack is missing only a non-history scope', async () => {
			mockUseIntegrations.mockReturnValue({
				data: [
					buildIntegrationResponse({
						provider: 'slack',
						status: 'active',
						missingScopes: ['reactions:write'],
						needsReconnect: true,
					}),
				],
				isLoading: false,
			})
			mockUseProviders.mockReturnValue({ data: [slackProvider], isLoading: false })
			render(<IntegrationsPage />)
			await expandCard('Slack')

			expect(
				screen.getByText('Update needed — reconnect to grant 1 new permission'),
			).toBeInTheDocument()
			expect(
				screen.queryByText(/Slack agents need history access to read channel backlog/),
			).not.toBeInTheDocument()
		})
	})

	describe('linkedin identity add-on pricing copy', () => {
		const renderLinkedIn = async () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [
					{
						name: 'linkedin-unipile',
						displayName: 'LinkedIn',
						authType: 'oauth2',
						events: [],
					},
				],
				isLoading: false,
			})
			render(<IntegrationsPage />)
		}

		it('states the per-identity price on a non-enterprise plan', async () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'pro' } })
			await renderLinkedIn()
			expect(screen.getByText(/\$49/)).toBeInTheDocument()
		})

		it('says the add-on is included instead of priced on an enterprise plan', async () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'enterprise' } })
			await renderLinkedIn()
			expect(screen.getByText(/Included in your enterprise plan/)).toBeInTheDocument()
			expect(screen.queryByText(/\$49/)).not.toBeInTheDocument()
		})

		it('states neither line until the plan is known', async () => {
			mockUseBillingUsage.mockReturnValue({ data: undefined })
			await renderLinkedIn()
			expect(screen.queryByText(/\$49/)).not.toBeInTheDocument()
			expect(screen.queryByText(/Included in your enterprise plan/)).not.toBeInTheDocument()
		})
	})
	describe('linkedin accounts are listed per member', () => {
		const LINKEDIN_PROVIDER = {
			name: 'linkedin-unipile',
			displayName: 'LinkedIn',
			authType: 'oauth2',
			events: [],
		}

		const renderWith = (integrations: unknown[]) => {
			mockUseIntegrations.mockReturnValue({ data: integrations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [LINKEDIN_PROVIDER], isLoading: false })
			render(<IntegrationsPage />)
		}

		const linkedInFor = (actorId: string, externalId: string) =>
			buildIntegrationResponse({
				provider: 'linkedin-unipile',
				status: 'active',
				actorId,
				externalId,
			})

		it('labels each connected account by the member who connected it', async () => {
			renderWith([linkedInFor('actor-1', 'acct-a'), linkedInFor('actor-2', 'acct-b')])
			// The group starts collapsed; open it.
			await userEvent.click(screen.getByRole('button', { name: /LinkedIn · 2/ }))
			expect(await screen.findByText('Magnus')).toBeInTheDocument()
			expect(screen.getByText('Colleague')).toBeInTheDocument()
			expect(screen.getByText('2 connected accounts')).toBeInTheDocument()
		})

		it("marks the current member's own account so two rows are tellable apart", async () => {
			renderWith([linkedInFor('actor-1', 'acct-a'), linkedInFor('actor-2', 'acct-b')])
			await userEvent.click(screen.getByRole('button', { name: /LinkedIn · 2/ }))
			expect(await screen.findByText('(you)')).toBeInTheDocument()
		})

		it('offers a member who has not connected their own account', async () => {
			// Only the colleague has connected — this is the case that used to
			// render a bare "Disconnect" and no way in.
			mockUseAuth.mockReturnValue({ actor: { id: 'actor-1' } })
			renderWith([linkedInFor('actor-2', 'acct-b')])
			const user = userEvent.setup()
			await user.click(screen.getByRole('button', { name: /LinkedIn/ }))
			expect(
				await screen.findByRole('button', { name: /Connect your account/ }),
			).toBeInTheDocument()
		})

		it('does not offer a second account to a member who already has one', async () => {
			renderWith([linkedInFor('actor-1', 'acct-a')])
			const user = userEvent.setup()
			await user.click(screen.getByRole('button', { name: /LinkedIn/ }))
			await screen.findByText('Magnus')
			expect(screen.queryByRole('button', { name: /Connect your account/ })).not.toBeInTheDocument()
			expect(
				screen.queryByRole('button', { name: /Connect another installation/ }),
			).not.toBeInTheDocument()
		})

		it('still states the per-identity price once accounts are connected', async () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'pro' } })
			renderWith([linkedInFor('actor-1', 'acct-a')])
			expect(await screen.findByText(/\$49/)).toBeInTheDocument()
		})
	})
})

describe('IntegrationsPage shelves, search and pills', () => {
	const providers = [
		{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] },
		{ name: 'gmail', displayName: 'Gmail', authType: 'oauth2', events: [] },
		{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [] },
	]

	beforeEach(() => {
		mockUseIntegrations.mockReturnValue({
			data: [buildIntegrationResponse({ provider: 'slack', status: 'active' })],
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({ data: providers, isLoading: false })
	})

	const searchbox = () => screen.getByRole('searchbox', { name: /Search integrations/ })

	it('puts connected tools first and the rest in the shelves below, with no tabs', () => {
		render(<IntegrationsPage />)
		const yours = within(screen.getByRole('region', { name: 'Your integrations' }))
		expect(yours.getByText('Slack')).toBeInTheDocument()
		expect(yours.queryByText('Gmail')).not.toBeInTheDocument()
		expect(allIntegrations().getByText('Gmail')).toBeInTheDocument()
		expect(allIntegrations().queryByText('Slack')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^Discover/ })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^Connected/ })).not.toBeInTheDocument()
	})

	it('shows Popular for tools in the editorial list that are not connected, and repeats them in All integrations', () => {
		render(<IntegrationsPage />)
		const popular = within(screen.getByRole('region', { name: 'Popular' }))
		// Slack is connected, so it is in Your integrations and not on the shelf.
		expect(popular.getByText('Gmail')).toBeInTheDocument()
		expect(popular.getByText('GitHub')).toBeInTheDocument()
		expect(popular.queryByText('Slack')).not.toBeInTheDocument()
		expect(allIntegrations().getByText('Gmail')).toBeInTheDocument()
		// Nothing in the fixture is new, so the shelf is not drawn.
		expect(screen.queryByRole('region', { name: 'New' })).not.toBeInTheDocument()
	})

	it('divides All integrations into the category groups, each with a count', () => {
		render(<IntegrationsPage />)
		expect(allIntegrations().getByRole('heading', { name: /Email & calendar/ })).toBeInTheDocument()
		expect(allIntegrations().getByRole('heading', { name: /Code/ })).toBeInTheDocument()
		// Slack is connected, so Chat & social has no tool left and the group is not drawn.
		expect(
			allIntegrations().queryByRole('heading', { name: /Chat & social/ }),
		).not.toBeInTheDocument()
	})

	it('turns the page into one filtered list when something is typed', async () => {
		render(<IntegrationsPage />)
		await userEvent.type(searchbox(), 'git')
		const results = within(screen.getByRole('region', { name: 'Results for “git”' }))
		expect(results.getByText('GitHub')).toBeInTheDocument()
		expect(results.queryByText('Gmail')).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'Popular' })).not.toBeInTheDocument()
		expect(screen.queryByRole('region', { name: 'All integrations' })).not.toBeInTheDocument()
	})

	it('keeps only matching connected tools in Your integrations while searching', async () => {
		render(<IntegrationsPage />)
		await userEvent.type(searchbox(), 'git')
		expect(screen.queryByRole('region', { name: 'Your integrations' })).not.toBeInTheDocument()
		await userEvent.clear(searchbox())
		await userEvent.type(searchbox(), 'sla')
		expect(
			within(screen.getByRole('region', { name: 'Your integrations' })).getByText('Slack'),
		).toBeInTheDocument()
	})

	it('clears the search text on Esc, then leaves the field on a second Esc', async () => {
		render(<IntegrationsPage />)
		const field = searchbox()
		await userEvent.type(field, 'git')
		expect(field).toHaveValue('git')

		await userEvent.keyboard('{Escape}')
		expect(field).toHaveValue('')
		expect(field).toHaveFocus()
		expect(allIntegrations().getByText('Gmail')).toBeInTheDocument()

		await userEvent.keyboard('{Escape}')
		expect(field).not.toHaveFocus()
	})

	it('filters by category pill and titles the list with the pill name', async () => {
		render(<IntegrationsPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Code' }))
		const results = within(screen.getByRole('region', { name: 'Code' }))
		expect(results.getByText('GitHub')).toBeInTheDocument()
		expect(results.queryByText('Gmail')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true')
	})

	it('filters by vendor pill, across categories', async () => {
		mockUseProviders.mockReturnValue({
			data: [
				...providers,
				{ name: 'google-drive', displayName: 'Google Drive', authType: 'oauth2', events: [] },
				{ name: 'microsoft', displayName: 'Microsoft', authType: 'oauth2', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Google' }))
		const results = within(screen.getByRole('region', { name: 'Google' }))
		// Gmail is in Email & calendar and Google Drive is in Files: one vendor, two categories.
		expect(results.getByText('Gmail')).toBeInTheDocument()
		expect(results.getByText('Google Drive')).toBeInTheDocument()
		expect(results.queryByText('Microsoft')).not.toBeInTheDocument()
		expect(results.queryByText('GitHub')).not.toBeInTheDocument()
	})

	it('says so, with a way out, when a search matches nothing', async () => {
		render(<IntegrationsPage />)
		await userEvent.type(searchbox(), 'zzz')
		expect(screen.getByText('No integration matches that search')).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
		expect(searchbox()).toHaveValue('')
		expect(screen.getByRole('region', { name: 'All integrations' })).toBeInTheDocument()
	})

	it('says nothing matches the filter for a category with no providers in it', async () => {
		render(<IntegrationsPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Sales & payments' }))
		expect(screen.getByText('No integration matches that filter')).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
		expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
	})

	it('files the bookkeeping providers under the Accounting pill, not Sales & payments', async () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'numina', displayName: 'Numina', authType: 'api_key', events: [] },
				{ name: 'dinero', displayName: 'Dinero', authType: 'oauth2', events: [] },
				{ name: 'uniconta', displayName: 'Uniconta', authType: 'api_key', events: [] },
				{ name: 'stripe', displayName: 'Stripe', authType: 'oauth2', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		await userEvent.click(screen.getByRole('button', { name: 'Accounting' }))
		const results = within(screen.getByRole('region', { name: 'Accounting' }))
		expect(results.getByText('Numina')).toBeInTheDocument()
		expect(results.getByText('Dinero')).toBeInTheDocument()
		expect(results.getByText('Uniconta')).toBeInTheDocument()
		expect(results.queryByText('Stripe')).not.toBeInTheDocument()
	})

	it('shows a dashed Nothing connected yet card when nothing is connected', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		render(<IntegrationsPage />)
		expect(screen.getByText('Nothing connected yet')).toBeInTheDocument()
		expect(allIntegrations().getByText('Slack')).toBeInTheDocument()
	})

	it('hides the shelves it has nothing for when every tool is connected', () => {
		mockUseIntegrations.mockReturnValue({
			data: providers.map((p) => buildIntegrationResponse({ provider: p.name, status: 'active' })),
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(screen.queryByRole('region', { name: 'Popular' })).not.toBeInTheDocument()
		expect(allIntegrations().queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
	})

	it('says it could not load, and Try again asks again', async () => {
		const refetch = vi.fn()
		mockUseIntegrations.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			refetch,
		})
		mockUseProviders.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch })
		render(<IntegrationsPage />)
		expect(screen.getByText("Couldn't load integrations")).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
		expect(refetch).toHaveBeenCalled()
	})
})

describe('IntegrationsPage Your integrations list', () => {
	const names = ['slack', 'github', 'gmail', 'linear', 'notion', 'posthog', 'stripe']
	const providers = names.map((name) => ({
		name,
		displayName: name.charAt(0).toUpperCase() + name.slice(1),
		authType: 'oauth2',
		events: [],
	}))

	it('shows five at first and expands in place with Show all, then Show fewer', async () => {
		mockUseIntegrations.mockReturnValue({
			data: names.map((n) => buildIntegrationResponse({ id: n, provider: n, status: 'active' })),
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({ data: providers, isLoading: false })
		render(<IntegrationsPage />)
		const yours = within(screen.getByRole('region', { name: 'Your integrations' }))
		// Seven connected tools: five rows and a button that says how many there are.
		expect(
			yours.getAllByRole('button', { name: /^(Slack|Github|Gmail|Linear|Notion|Posthog|Stripe)/ }),
		).toHaveLength(5)
		await userEvent.click(yours.getByRole('button', { name: 'Show all 7' }))
		expect(
			yours.getAllByRole('button', { name: /^(Slack|Github|Gmail|Linear|Notion|Posthog|Stripe)/ }),
		).toHaveLength(7)
		await userEvent.click(yours.getByRole('button', { name: 'Show fewer' }))
		expect(yours.getByRole('button', { name: 'Show all 7' })).toBeInTheDocument()
	})

	it('lists a broken tool first', () => {
		mockUseIntegrations.mockReturnValue({
			data: names.map((n) =>
				buildIntegrationResponse({
					id: n,
					provider: n,
					status: 'active',
					...(n === 'stripe' ? { needsReconnect: true, missingScopes: ['read'] } : {}),
				}),
			),
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({ data: providers, isLoading: false })
		render(<IntegrationsPage />)
		const yours = within(screen.getByRole('region', { name: 'Your integrations' }))
		expect(yours.getAllByRole('button', { expanded: false })[0]).toHaveTextContent(/^Stripe/)
	})
})

describe('IntegrationsPage needs attention strip', () => {
	it('names a tool that needs reconnecting, with a Reconnect that starts its sign-in', async () => {
		mockUseIntegrations.mockReturnValue({
			data: [
				buildIntegrationResponse({
					provider: 'slack',
					status: 'active',
					needsReconnect: true,
					missingScopes: ['channels:history'],
				}),
			],
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({
			data: [{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		const strip = within(screen.getByRole('region', { name: 'Needs attention' }))
		expect(
			strip.getByText(
				"Slack needs to be reconnected. Agents can't read channel history until you do.",
			),
		).toBeInTheDocument()
		await userEvent.click(strip.getByRole('button', { name: 'Reconnect Slack' }))
		expect(mockConnect).toHaveBeenCalledWith({ provider: 'slack' })
	})

	it('names an unfinished Resend setup, with Finish setup', () => {
		mockUseIntegrations.mockReturnValue({
			data: [
				buildIntegrationResponse({
					id: 'rs-1',
					provider: 'resend',
					status: 'awaiting_secret',
					config: {
						resend: {
							receive_subdomain: 'in.acme.test',
							webhook_url: 'https://acme.test/hook',
							dns_records: [],
							verification_status: 'pending',
						},
					},
				}),
			],
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({
			data: [{ name: 'resend', displayName: 'Resend', authType: 'api_key', events: [] }],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		const strip = within(screen.getByRole('region', { name: 'Needs attention' }))
		expect(
			strip.getByText("Resend setup isn't finished. It's waiting for the webhook signing secret."),
		).toBeInTheDocument()
		expect(strip.getByRole('button', { name: 'Finish setup Resend' })).toBeInTheDocument()
	})

	it('is not drawn when everything is fine', () => {
		mockUseIntegrations.mockReturnValue({
			data: [buildIntegrationResponse({ provider: 'slack', status: 'active' })],
			isLoading: false,
		})
		mockUseProviders.mockReturnValue({
			data: [{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument()
	})
})

describe('IntegrationsPage ordering', () => {
	it('lists providers alphabetically by name inside a category group', async () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'linear', displayName: 'Linear', authType: 'oauth2', events: [] },
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [] },
				{ name: 'cloudflare', displayName: 'Cloudflare', authType: 'oauth2', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)

		// All three are in the Code group.
		const all = allIntegrations()
		const cf = all.getByText('Cloudflare', { exact: false })
		const gh = all.getByText('GitHub', { exact: false })
		const li = all.getByText('Linear', { exact: false })
		expect(cf.compareDocumentPosition(gh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(gh.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('orders the groups as the pills are ordered', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [] },
				{ name: 'gmail', displayName: 'Gmail', authType: 'oauth2', events: [] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		const headings = allIntegrations()
			.getAllByRole('heading', { level: 3 })
			.map((h) => h.textContent)
		expect(headings[0]).toMatch(/^Email & calendar/)
		expect(headings[1]).toMatch(/^Code/)
	})
})
