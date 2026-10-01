import type { GithubPendingSelection, LinkableGithubInstallation } from '@/lib/api'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockUseIntegrations = vi.fn()
const mockUseProviders = vi.fn()
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()

/** Search params the route sees. The page reads `?select_github=<id>` to decide
 *  whether to open the post-authorization org picker. */
const mockSearch = vi.fn<() => Record<string, string | undefined>>(() => ({}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useSearch: () => mockSearch(),
			fullPath: '/_authed/$workspaceId/settings/integrations',
		}),
	}
})

vi.mock('@/lib/workspace-context', () => ({
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
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	ListSkeleton: () => <div data-testid="list-skeleton" />,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: React.FC }).component

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

	it('renders provider list with display names', () => {
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [
				{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] },
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2', events: [{ type: 'push' }] },
			],
			isLoading: false,
		})
		render(<IntegrationsPage />)
		expect(screen.getByText('Slack')).toBeInTheDocument()
		expect(screen.getByText('GitHub')).toBeInTheDocument()
	})

	it('shows Connect for disconnected and Disconnect for connected providers', () => {
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
		expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
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

		it('renders one header showing the count, with nested rows for each installation', () => {
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			expect(screen.getByText('GitHub · 2')).toBeInTheDocument()
			expect(screen.getByText('vaerksted-ai')).toBeInTheDocument()
			expect(screen.getByText('sindre-ai')).toBeInTheDocument()
			// Two nested disconnect buttons + no top-level disconnect on the header
			expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(2)
		})

		it('defaults to expanded when more than one installation exists', () => {
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const header = screen.getByRole('button', { name: /GitHub · 2/ })
			expect(header).toHaveAttribute('aria-expanded', 'true')
			expect(screen.getByRole('button', { name: /Add another/ })).toBeInTheDocument()
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
			expect(screen.queryByRole('button', { name: /Add another/ })).not.toBeInTheDocument()
		})

		it('toggles the nested list when the header is clicked — no chevron, header IS the toggle', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const header = screen.getByRole('button', { name: /GitHub · 2/ })
			await user.click(header)
			expect(header).toHaveAttribute('aria-expanded', 'false')
			expect(screen.queryByText('vaerksted-ai')).not.toBeInTheDocument()

			await user.click(header)
			expect(header).toHaveAttribute('aria-expanded', 'true')
			expect(screen.getByText('vaerksted-ai')).toBeInTheDocument()
		})

		it('disconnects only the targeted installation when a nested Disconnect is clicked', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			const sindreRow = screen.getByText('sindre-ai').closest('div.flex') as HTMLElement
			await user.click(within(sindreRow).getByRole('button', { name: 'Disconnect' }))

			expect(mockDisconnect).toHaveBeenCalledTimes(1)
			expect(mockDisconnect).toHaveBeenCalledWith('gh-2')
		})

		it('"Add another" triggers the connect flow for github', async () => {
			const user = userEvent.setup()
			mockUseIntegrations.mockReturnValue({ data: twoInstallations, isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			await user.click(screen.getByRole('button', { name: /Add another/ }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'github' })
		})

		it('falls back to the single-row Connect UI when github has no active installations', () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [githubProvider], isLoading: false })
			render(<IntegrationsPage />)

			expect(screen.queryByText(/GitHub · /)).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
		})

		it('does not group non-github providers even when multiple integrations exist for them', () => {
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

			expect(screen.getByText('Google Calendar')).toBeInTheDocument()
			expect(screen.getByText('Connected as magnus@example.com')).toBeInTheDocument()
			expect(screen.queryByText(/Installation /)).not.toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: 'Disconnect' }))
			expect(mockDisconnect).toHaveBeenCalledWith('gc-1')
		})

		it('shows "Available to connect" when not connected (no event types defined yet)', () => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [googleCalendarProvider], isLoading: false })

			render(<IntegrationsPage />)

			expect(screen.getByText('Available to connect')).toBeInTheDocument()
			expect(screen.queryByText(/event types available/)).not.toBeInTheDocument()
		})
	})

	describe('gmail label remains unchanged', () => {
		const gmailProvider = {
			name: 'gmail',
			displayName: 'Gmail',
			authType: 'oauth2',
			events: [{ entityType: 'gmail.message', actions: ['received'], label: 'Email' }],
			externalIdDisplay: 'email' as const,
		}

		it('shows "Connected as <email>" for Gmail when externalIdDisplay is email', () => {
			const integration = buildIntegrationResponse({
				id: 'gm-1',
				provider: 'gmail',
				status: 'active',
				externalId: 'user@gmail.com',
			})
			mockUseIntegrations.mockReturnValue({ data: [integration], isLoading: false })
			mockUseProviders.mockReturnValue({ data: [gmailProvider], isLoading: false })

			render(<IntegrationsPage />)

			expect(screen.getByText('Connected as user@gmail.com')).toBeInTheDocument()
			expect(screen.queryByText(/Installation /)).not.toBeInTheDocument()
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

		await user.click(screen.getByRole('button', { name: /Add existing/ }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText('acme-org')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Add' }))
		expect(mockLinkGithub).toHaveBeenCalledWith('4242', expect.anything())
	})

	it('hides "Add existing" when every reachable installation is already here', () => {
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

	// Slack agents need channel history to dedupe threads and load context, so
	// when the stored token is missing one of those scopes the card swaps the
	// generic "grant N permissions" copy for a Slack-specific one that names
	// what reconnecting unlocks. The Reconnect button re-triggers the same
	// OAuth flow an operator would hit from the reactive withScopeHint error.
	describe('slack reconnect-required label', () => {
		const slackProvider = { name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }

		it('renders the Slack-specific label when a history scope is missing', () => {
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

			expect(
				screen.getByText(
					'Reconnect required — Slack agents need history access to read channel backlog.',
				),
			).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
		})

		it('hides the Reconnect button and Slack-specific label when all three history scopes are granted', () => {
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

			expect(screen.getByText('Connected')).toBeInTheDocument()
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

			await user.click(screen.getByRole('button', { name: 'Reconnect' }))
			expect(mockConnect).toHaveBeenCalledWith({ provider: 'slack' })
		})

		it('falls through to the generic copy when Slack is missing only a non-history scope', () => {
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

			expect(
				screen.getByText('Update needed — reconnect to grant 1 new permission'),
			).toBeInTheDocument()
			expect(
				screen.queryByText(/Slack agents need history access to read channel backlog/),
			).not.toBeInTheDocument()
		})
	})

	describe('linkedin identity add-on pricing copy', () => {
		const renderLinkedIn = () => {
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

		it('states the per-identity price on a non-enterprise plan', () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'pro' } })
			renderLinkedIn()
			expect(screen.getByText(/\$49/)).toBeInTheDocument()
		})

		it('says the add-on is included instead of priced on an enterprise plan', () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'enterprise' } })
			renderLinkedIn()
			expect(screen.getByText(/Included in your enterprise plan/)).toBeInTheDocument()
			expect(screen.queryByText(/\$49/)).not.toBeInTheDocument()
		})

		it('states neither line until the plan is known', () => {
			mockUseBillingUsage.mockReturnValue({ data: undefined })
			renderLinkedIn()
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
			// Two installs default the group to expanded.
			expect(await screen.findByText('Magnus')).toBeInTheDocument()
			expect(screen.getByText('Colleague')).toBeInTheDocument()
			expect(screen.getByText('2 connected accounts')).toBeInTheDocument()
		})

		it("marks the current member's own account so two rows are tellable apart", async () => {
			renderWith([linkedInFor('actor-1', 'acct-a'), linkedInFor('actor-2', 'acct-b')])
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
			expect(screen.queryByRole('button', { name: /Add another/ })).not.toBeInTheDocument()
		})

		it('still states the per-identity price once accounts are connected', async () => {
			mockUseBillingUsage.mockReturnValue({ data: { plan: 'pro' } })
			renderWith([linkedInFor('actor-1', 'acct-a')])
			expect(await screen.findByText(/\$49/)).toBeInTheDocument()
		})
	})
})
