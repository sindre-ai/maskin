import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const connectMutate = vi.fn()
let providers: ProviderInfo[] = []
let integrations: IntegrationResponse[] = []
let visible = true
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
vi.mock('@/hooks/use-provider-visibility', () => ({
	useProviderVisibility: () => () => visible,
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

function renderCard(name: string) {
	return render(
		<IntegrationConnectCard workspaceId="ws-1" conversationId="conv-1" provider={name} />,
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
		visible = true
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
		// Removing an integration stays in Settings; a chat card must not offer it.
		expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument()
	})

	it('does not treat a revoked integration as connected', () => {
		providers = [provider({})]
		integrations = [{ ...active('linear'), status: 'revoked' }]
		renderCard('linear')

		expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
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

	it('renders nothing for a provider hidden behind a feature flag the actor lacks', () => {
		providers = [provider({ name: 'google-meet', displayName: 'Google Meet' })]
		visible = false
		const { container } = renderCard('google-meet')

		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing for a provider the server does not list', () => {
		providers = [provider({})]
		const { container } = renderCard('not-a-provider')

		expect(container).toBeEmptyDOMElement()
	})
})
