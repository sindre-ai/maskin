import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const connectMutate = vi.fn()
const saveMutate = vi.fn()
let savedApp: { configured: boolean; clientId?: string; callbackUrl: string } = {
	configured: false,
	callbackUrl: 'https://api.example.com/api/integrations/salesforce/callback',
}

vi.mock('@/hooks/use-integrations', () => ({
	useConnectIntegration: () => ({ mutate: connectMutate, isPending: false, isError: false }),
	useDisconnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
	useLinkableGithubInstallations: () => ({ data: [], isLoading: false }),
	useOAuthApp: () => ({ data: savedApp }),
	useSaveOAuthApp: () => ({
		mutate: saveMutate,
		reset: vi.fn(),
		isPending: false,
		isError: false,
	}),
}))
vi.mock('@/hooks/use-identity-addon-pricing', () => ({
	useIdentityAddonPricing: () => ({ isFree: false, isPaid: false }),
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ actor: { id: 'actor-1' } }) }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))

import { ProviderConnectRow } from '@/components/integrations/provider-connect-row'

const salesforce: ProviderInfo = {
	name: 'salesforce',
	displayName: 'Salesforce',
	authType: 'oauth2',
	events: [],
	customerApp: true,
}
const linear: ProviderInfo = {
	name: 'linear',
	displayName: 'Linear',
	authType: 'oauth2',
	events: [],
}

function renderRow(provider: ProviderInfo, installations: IntegrationResponse[] = []) {
	return render(
		<ProviderConnectRow provider={provider} installations={installations} workspaceId="ws-1" />,
		{ wrapper: TestWrapper },
	)
}

describe('Connect for a tool that wants the customer own app', () => {
	beforeEach(() => {
		connectMutate.mockClear()
		saveMutate.mockClear()
		savedApp = {
			configured: false,
			callbackUrl: 'https://api.example.com/api/integrations/salesforce/callback',
		}
	})

	it('opens the paste form first and starts no sign-in', async () => {
		renderRow(salesforce)
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		expect(await screen.findByText('Connect Salesforce')).toBeInTheDocument()
		expect(screen.getByDisplayValue(savedApp.callbackUrl)).toBeInTheDocument()
		expect(connectMutate).not.toHaveBeenCalled()
	})

	it('sends the pasted id and secret, with the secret in a password field', async () => {
		renderRow(salesforce)
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		const save = await screen.findByRole('button', { name: 'Save and connect' })
		expect(save).toBeDisabled()
		await userEvent.type(screen.getByLabelText('App ID'), ' 3MVG9abc ')
		const secret = screen.getByLabelText('App secret')
		expect(secret).toHaveAttribute('type', 'password')
		await userEvent.type(secret, 's3cr3t')
		await userEvent.click(save)
		expect(saveMutate).toHaveBeenCalledWith(
			{ clientId: '3MVG9abc', clientSecret: 's3cr3t' },
			expect.any(Object),
		)
	})

	it('goes straight to the sign-in once the app is saved, and offers to change it', async () => {
		savedApp = { ...savedApp, configured: true, clientId: '3MVG9abc' }
		renderRow(salesforce)
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		expect(connectMutate).toHaveBeenCalledWith({ provider: 'salesforce', returnTo: undefined })
		await userEvent.click(screen.getByRole('button', { name: 'Change app' }))
		expect(await screen.findByText('Change the Salesforce app')).toBeInTheDocument()
	})

	it('leaves every other tool alone: Connect signs in and nothing asks for an app', async () => {
		renderRow(linear)
		await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
		expect(connectMutate).toHaveBeenCalledWith({ provider: 'linear', returnTo: undefined })
		expect(screen.queryByText('Change app')).not.toBeInTheDocument()
	})
})
