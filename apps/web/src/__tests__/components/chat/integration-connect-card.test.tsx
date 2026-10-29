import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import type { IntegrationToolState } from '@/lib/integration-tool-state'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const connectMutate = vi.fn()
let providers: ProviderInfo[] = []
let integrations: IntegrationResponse[] = []
let pricing = { isFree: false, isPaid: false }

vi.mock('@/hooks/use-integrations', () => ({
	useProviders: () => ({ data: providers }),
	useIntegrations: () => ({ data: integrations }),
	useConnectIntegration: () => ({ mutate: connectMutate, isPending: false }),
	useDisconnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
	useCompleteIntegration: () => ({ mutate: vi.fn(), isPending: false }),
	useLinkGithubInstallation: () => ({ mutate: vi.fn(), isPending: false }),
	useLinkableGithubInstallations: () => ({ data: [], isLoading: false }),
}))
vi.mock('@/hooks/use-identity-addon-pricing', () => ({
	useIdentityAddonPricing: () => pricing,
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ actor: { id: 'actor-1' } }) }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))

import { IntegrationConnectCard } from '@/components/chat/integration-connect-card'

const RETURN_TO = '/ws-1/chats/conv-1'

function provider(overrides: Partial<ProviderInfo>): ProviderInfo {
	return {
		name: 'linear',
		displayName: 'Linear',
		authType: 'oauth2',
		events: Array.from({ length: 9 }, (_, i) => ({
			entityType: `entity_${i}`,
			actions: ['created'],
			label: `Event ${i}`,
		})),
		...overrides,
	}
}

function active(providerName: string, id = 'i-1'): IntegrationResponse {
	return {
		id,
		provider: providerName,
		status: 'active',
		externalId: id,
		config: {},
	} as unknown as IntegrationResponse
}

function renderCard(name: string, introState?: IntegrationToolState) {
	return render(
		<IntegrationConnectCard
			workspaceId="ws-1"
			conversationId="conv-1"
			provider={name}
			introState={introState}
		/>,
		{
			wrapper: TestWrapper,
		},
	)
}

describe('IntegrationConnectCard', () => {
	beforeEach(() => {
		connectMutate.mockClear()
		providers = []
		integrations = []
		pricing = { isFree: false, isPaid: false }
	})

	it('starts the OAuth flow with the chat as the return path, so the user lands back here', async () => {
		providers = [provider({})]
		renderCard('linear')

		expect(screen.getByText('9 event types available')).toBeInTheDocument()
		await userEvent.setup().click(screen.getByRole('button', { name: 'Connect' }))

		expect(connectMutate).toHaveBeenCalledWith({ provider: 'linear', returnTo: RETURN_TO })
	})

	it('shows a disabled Connected button — not Connect or Disconnect — once connected', () => {
		providers = [provider({})]
		integrations = [active('linear')]
		renderCard('linear')

		expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled()
		expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
		// Removing an integration stays in Settings; a chat card must not offer it.
		expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
	})

	it('does not treat a revoked integration as connected, and offers Reconnect', async () => {
		providers = [provider({})]
		integrations = [{ ...active('linear'), status: 'revoked' }]
		renderCard('linear')

		expect(screen.queryByRole('button', { name: 'Connected' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
		await userEvent.setup().click(screen.getByRole('button', { name: 'Reconnect' }))

		expect(connectMutate).toHaveBeenCalledWith({ provider: 'linear', returnTo: RETURN_TO })
	})

	it('keeps the Connect label for a pending integration, which is an unfinished connect', () => {
		providers = [provider({})]
		integrations = [{ ...active('linear'), status: 'pending' }]
		renderCard('linear')

		expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
	})

	it('takes an API key in the dialog and sends it, with the return path, to the connect call', async () => {
		providers = [
			provider({ name: 'posthog', displayName: 'PostHog', authType: 'api_key', events: [] }),
		]
		const user = userEvent.setup()
		renderCard('posthog')

		await user.click(screen.getByRole('button', { name: 'Connect' }))
		const dialog = await screen.findByRole('dialog')
		const input = within(dialog).getByLabelText('API key')
		// Masked: a key typed into a chat surface must not be shoulder-surfable.
		expect(input).toHaveAttribute('type', 'password')
		const submit = within(dialog).getByRole('button', { name: 'Connect' })
		expect(submit).toBeDisabled()

		await user.type(input, 'phx_secret')
		await user.click(submit)

		expect(connectMutate).toHaveBeenCalledTimes(1)
		expect(connectMutate.mock.calls[0]?.[0]).toEqual({
			provider: 'posthog',
			apiKey: 'phx_secret',
			returnTo: RETURN_TO,
		})
	})

	it('offers "+ Add another" next to Connected for a provider that allows several installs', async () => {
		providers = [provider({ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom' })]
		integrations = [active('github', 'g-1'), active('github', 'g-2')]
		renderCard('github')

		expect(screen.getByText('2 active installations')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled()
		await userEvent.setup().click(screen.getByRole('button', { name: 'Add another' }))

		expect(connectMutate).toHaveBeenCalledWith({ provider: 'github', returnTo: RETURN_TO })
	})

	it('states the LinkedIn price on the card before connecting', () => {
		providers = [provider({ name: 'linkedin-unipile', displayName: 'LinkedIn' })]
		pricing = { isFree: false, isPaid: true }
		renderCard('linkedin-unipile')

		expect(
			screen.getByText('$49/month per connected identity, added to your Maskin subscription.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
	})

	it('renders nothing for a provider the server does not list', () => {
		providers = [provider({})]
		const { container } = renderCard('not-a-provider')

		expect(container).toBeEmptyDOMElement()
	})

	describe('the quiet intro row', () => {
		it('says "Not connected yet" with an outline Connect button named for the tool', async () => {
			providers = [provider({})]
			renderCard('linear', 'missing')

			expect(screen.getByText('Not connected yet')).toBeInTheDocument()
			expect(screen.queryByText('9 event types available')).not.toBeInTheDocument()
			const connect = screen.getByRole('button', { name: 'Connect Linear' })
			expect(connect).toHaveTextContent('Connect')
			await userEvent.setup().click(connect)

			expect(connectMutate).toHaveBeenCalledWith({ provider: 'linear', returnTo: RETURN_TO })
		})

		it('says "Needs reconnecting" with a Reconnect button for a revoked row', () => {
			providers = [provider({})]
			integrations = [{ ...active('linear'), status: 'revoked' }]
			renderCard('linear', 'needs_reconnect')

			expect(screen.getByText('Needs reconnecting')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Reconnect Linear' })).toBeInTheDocument()
		})

		it('says "Connected, ready to use" only for a tool the agent can use', () => {
			providers = [provider({})]
			integrations = [active('linear')]
			renderCard('linear', 'ready')

			expect(screen.getByText('Connected, ready to use')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled()
		})

		it('says "Connected to the workspace" when the agent cannot use the tool yet', () => {
			providers = [provider({})]
			integrations = [active('linear')]
			renderCard('linear', 'connected_not_on_agent')

			expect(screen.getByText('Connected to the workspace')).toBeInTheDocument()
			expect(screen.queryByText('Connected, ready to use')).not.toBeInTheDocument()
		})

		it('draws one quiet row, not the install count card, for a multi-install provider', () => {
			providers = [provider({ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom' })]
			integrations = [active('github', 'g-1')]
			renderCard('github', 'connected_not_on_agent')

			expect(screen.getByText('GitHub')).toBeInTheDocument()
			expect(screen.getByText('Connected to the workspace')).toBeInTheDocument()
			expect(screen.queryByText('GitHub · 1')).not.toBeInTheDocument()
			expect(screen.queryByText('1 active installation')).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Add another' })).not.toBeInTheDocument()
		})

		it('says "Needs reconnecting" with one Reconnect button when the sign-in lacks permissions', async () => {
			providers = [provider({ name: 'slack', displayName: 'Slack' })]
			integrations = [
				{ ...active('slack'), needsReconnect: true, missingScopes: ['channels:history'] },
			]
			renderCard('slack', 'needs_reconnect')

			expect(screen.getByText('Needs reconnecting')).toBeInTheDocument()
			expect(screen.queryByText(/history access/)).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Connected' })).not.toBeInTheDocument()
			const reconnect = screen.getAllByRole('button', { name: 'Reconnect' })
			expect(reconnect).toHaveLength(1)
			await userEvent.setup().click(reconnect[0])

			expect(connectMutate).toHaveBeenCalledWith({ provider: 'slack', returnTo: RETURN_TO })
		})

		it('keeps the full card, with its event count subtitle, when no intro state is given', () => {
			providers = [provider({})]
			renderCard('linear')

			expect(screen.getByText('9 event types available')).toBeInTheDocument()
		})
	})
})
