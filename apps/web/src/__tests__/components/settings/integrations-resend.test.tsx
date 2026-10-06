import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

// The dialog is exercised in its own test file; here we only need to know
// it received an `open` prop and (optionally) a prefill. Stubbing it keeps
// this file focused on flag-gating and the resume affordance's decoding.
vi.mock('@/components/integrations/resend/resend-connect-dialog', () => ({
	ResendConnectDialog: ({
		open,
		prefill,
	}: {
		open: boolean
		prefill: unknown
	}) =>
		open ? <div data-testid="resend-dialog" data-prefill={prefill ? 'true' : 'false'} /> : null,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockUseIntegrations = vi.fn()
const mockUseProviders = vi.fn()
const mockUseFeatureFlag = vi.fn()

vi.mock('@/hooks/use-integrations', async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>()
	return {
		...original,
		useIntegrations: (...args: unknown[]) => mockUseIntegrations(...args),
		useProviders: (...args: unknown[]) => mockUseProviders(...args),
		useLinkableGithubInstallations: () => ({ data: [] }),
		useConnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
		useDisconnectIntegration: () => ({ mutate: vi.fn(), isPending: false }),
		useCompleteIntegration: () => ({ mutate: vi.fn(), isPending: false }),
		useLinkGithubInstallation: () => ({ mutate: vi.fn(), isPending: false }),
		useSelectGithubInstallation: () => ({ mutate: vi.fn(), isPending: false }),
		useGithubPendingSelection: () => ({ data: null, isLoading: false }),
	}
})

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => mockUseFeatureFlag(id),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ actor: { id: 'actor-1' } }),
}))

vi.mock('@/hooks/use-billing', () => ({
	useBillingUsage: () => ({ data: undefined }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
	const orig = await importOriginal<Record<string, unknown>>()
	return {
		...orig,
		createFileRoute: () => (opts: unknown) => opts,
		useNavigate: () => vi.fn(),
	}
})

// Import AFTER mocks are set up.
import { Route } from '@/routes/_authed/$workspaceId/settings/integrations'

const IntegrationsPage = (Route as unknown as { component: () => React.ReactElement }).component

const RESEND_PROVIDER: ProviderInfo = {
	name: 'resend',
	displayName: 'Resend',
	authType: 'manual',
	events: [],
}

const AWAITING_SECRET_RESEND_ROW: IntegrationResponse = {
	id: 'int-1',
	workspaceId: 'ws-1',
	provider: 'resend',
	status: 'awaiting_secret',
	externalId: 'tok',
	config: {
		resend: {
			receive_subdomain: 'mail.example.com',
			webhook_url: 'https://maskin.example/api/webhooks/resend/tok',
			verification_status: 'pending',
			dns_records: [
				{
					record: 'SPF',
					type: 'TXT',
					name: 'send.mail.example.com',
					value: 'v=spf1 include:amazonses.com ~all',
					status: 'pending',
				},
			],
		},
	},
	actorId: null,
	createdBy: 'actor-1',
	createdAt: null,
	updatedAt: null,
}

// TanStack Router's file-route `useSearch()` is a bound getter on the Route
// object — stub it before every test since the imported Route was created by
// our mocked `createFileRoute` above.
;(Route as unknown as { useSearch: () => Record<string, unknown> }).useSearch = () => ({})

describe('IntegrationsPage — resend gate', () => {
	beforeEach(() => {
		mockUseIntegrations.mockReset()
		mockUseProviders.mockReset()
		mockUseFeatureFlag.mockReset()
	})

	it('hides the Resend provider card AND the awaiting_secret resume affordance when flag is off', () => {
		mockUseFeatureFlag.mockImplementation(() => false)
		mockUseProviders.mockReturnValue({ data: [RESEND_PROVIDER], isLoading: false })
		mockUseIntegrations.mockReturnValue({
			data: [AWAITING_SECRET_RESEND_ROW],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<IntegrationsPage />
			</TestWrapper>,
		)

		// Card gone.
		expect(screen.queryByText('Resend')).not.toBeInTheDocument()
		// Resume section gone.
		expect(screen.queryByRole('button', { name: /resume connect/i })).not.toBeInTheDocument()
	})

	it('shows the Resend provider card AND surfaces a Resume affordance for awaiting_secret rows when flag is on', () => {
		mockUseFeatureFlag.mockImplementation((id: string) => id === 'resend-integration-ui')
		mockUseProviders.mockReturnValue({ data: [RESEND_PROVIDER], isLoading: false })
		mockUseIntegrations.mockReturnValue({
			data: [AWAITING_SECRET_RESEND_ROW],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<IntegrationsPage />
			</TestWrapper>,
		)

		expect(screen.getByText('Resend')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /resume connect/i })).toBeInTheDocument()
		expect(screen.getByText(/mail\.example\.com/)).toBeInTheDocument()
	})
})
