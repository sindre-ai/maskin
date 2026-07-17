import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockUseIntegrations = vi.fn()
const mockUseProviders = vi.fn()
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockUseLinkedinAccount = vi.fn()
const mockConnectLinkedin = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: (...args: unknown[]) => mockUseIntegrations(...args),
	useProviders: () => mockUseProviders(),
	useConnectIntegration: () => ({ mutate: mockConnect, isPending: false }),
	useDisconnectIntegration: () => ({ mutate: mockDisconnect, isPending: false }),
}))

vi.mock('@/hooks/use-linkedin-account', () => ({
	useLinkedinAccount: (...args: unknown[]) => mockUseLinkedinAccount(...args),
	useConnectLinkedin: () => ({ mutate: mockConnectLinkedin, isPending: false }),
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
		mockUseLinkedinAccount.mockReturnValue({ data: null, isLoading: false })
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
		// Two Connect buttons: LinkedIn (always rendered) + GitHub (disconnected).
		expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2)
	})

	it('keeps the api key dialog open until connect succeeds', async () => {
		const user = userEvent.setup()
		mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
		mockUseProviders.mockReturnValue({
			data: [{ name: 'posthog', displayName: 'PostHog', authType: 'api_key', events: [] }],
			isLoading: false,
		})
		render(<IntegrationsPage />)

		// The LinkedIn row also renders a Connect button — scope to the PostHog row.
		const posthogRow = screen.getByText('PostHog').closest('div.flex') as HTMLElement
		await user.click(within(posthogRow).getByRole('button', { name: 'Connect' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()

		await user.type(screen.getByLabelText('API key'), 'phx_test_key')
		expect(screen.getByDisplayValue('phx_test_key')).toBeInTheDocument()

		// The Connect button inside the dialog — scope to the dialog to avoid the
		// LinkedIn row's Connect button.
		const dialog = screen.getByRole('dialog')
		const connectButton = within(dialog).getByRole('button', { name: 'Connect' })
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
			// LinkedIn + GitHub each render a single Connect button.
			expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2)
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

			// LinkedIn row also renders "Available to connect" — scope to Google Calendar.
			const gcRow = screen.getByText('Google Calendar').closest('div.flex') as HTMLElement
			expect(within(gcRow).getByText('Available to connect')).toBeInTheDocument()
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

	describe('linkedin provider row', () => {
		beforeEach(() => {
			mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
			mockUseProviders.mockReturnValue({
				data: [{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] }],
				isLoading: false,
			})
		})

		function buildAccount(overrides: Partial<{ state: string; sendingAsName: string | null }>) {
			return {
				id: 'li-1',
				workspaceId: 'ws-1',
				state: overrides.state ?? 'healthy',
				unipileAccountId: 'unipile-acc-1',
				// `??` would swallow an explicit `null` here — use `in` so the test can
				// exercise the null-identity fallback in `describeLinkedinRow`.
				sendingAsName:
					'sendingAsName' in overrides ? overrides.sendingAsName : 'sindre.brekke',
				sendingAsProviderId: 'urn:li:person:abc',
				connectedAt: '2026-07-17T00:00:00Z',
				createdAt: '2026-07-17T00:00:00Z',
				updatedAt: '2026-07-17T00:00:00Z',
			}
		}

		it('renders a Connect button and "Available to connect" when there is no account', () => {
			mockUseLinkedinAccount.mockReturnValue({ data: null, isLoading: false })
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			expect(within(linkedinRow).getByText('Available to connect')).toBeInTheDocument()
			expect(within(linkedinRow).getByRole('button', { name: 'Connect' })).toBeInTheDocument()
		})

		it('sends the settings return_path when Connect is clicked so the callback lands back here', async () => {
			const user = userEvent.setup()
			mockUseLinkedinAccount.mockReturnValue({ data: null, isLoading: false })
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			await user.click(within(linkedinRow).getByRole('button', { name: 'Connect' }))

			expect(mockConnectLinkedin).toHaveBeenCalledWith({
				returnPath: '/ws-1/settings/integrations',
			})
		})

		it('shows a healthy connected identity with no reconnect action', () => {
			mockUseLinkedinAccount.mockReturnValue({
				data: buildAccount({ state: 'healthy' }),
				isLoading: false,
			})
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			expect(within(linkedinRow).getByText(/Connected as sindre\.brekke/)).toBeInTheDocument()
			expect(within(linkedinRow).getByText(/Healthy/)).toBeInTheDocument()
			expect(within(linkedinRow).queryByRole('button')).not.toBeInTheDocument()
		})

		it('shows a syncing indicator with no action button', () => {
			mockUseLinkedinAccount.mockReturnValue({
				data: buildAccount({ state: 'syncing' }),
				isLoading: false,
			})
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			expect(within(linkedinRow).getByText(/Syncing/)).toBeInTheDocument()
			expect(within(linkedinRow).queryByRole('button')).not.toBeInTheDocument()
		})

		it('shows Restricted with NO reconnect CTA (bet AC: restricted must not surface a reconnect)', () => {
			mockUseLinkedinAccount.mockReturnValue({
				data: buildAccount({ state: 'restricted' }),
				isLoading: false,
			})
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			expect(within(linkedinRow).getByText(/Restricted/)).toBeInTheDocument()
			expect(within(linkedinRow).queryByRole('button')).not.toBeInTheDocument()
		})

		it('surfaces a Reconnect button when the account is in the reconnect state', async () => {
			const user = userEvent.setup()
			mockUseLinkedinAccount.mockReturnValue({
				data: buildAccount({ state: 'reconnect' }),
				isLoading: false,
			})
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			const reconnect = within(linkedinRow).getByRole('button', { name: 'Reconnect' })
			expect(reconnect).toBeInTheDocument()

			await user.click(reconnect)
			expect(mockConnectLinkedin).toHaveBeenCalledWith({
				returnPath: '/ws-1/settings/integrations',
			})
		})

		it('falls back to a generic "Connected" label when sendingAsName is null', () => {
			mockUseLinkedinAccount.mockReturnValue({
				data: buildAccount({ state: 'warm_up', sendingAsName: null }),
				isLoading: false,
			})
			render(<IntegrationsPage />)

			const linkedinRow = screen.getByText('LinkedIn').closest('div.flex') as HTMLElement
			expect(within(linkedinRow).getByText(/^Connected · Warming up$/)).toBeInTheDocument()
		})
	})
})
