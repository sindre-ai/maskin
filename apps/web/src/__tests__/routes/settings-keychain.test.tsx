import type { CredentialAuditEntry, CredentialAuditLogPage } from '@/lib/api'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockNavigate = vi.fn()
const mockParams = vi.fn<() => Record<string, string>>(() => ({}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		Outlet: () => <p>child route</p>,
		createFileRoute: () => (options: Record<string, unknown>) => ({
			...options,
			useParams: () => mockParams(),
		}),
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockFlag = vi.fn<() => boolean>(() => true)
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => mockFlag() }))
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: () => {} }))

const mockUseIntegrations = vi.fn()
const mockCreate = vi.fn()
const mockUseAuditLog = vi.fn()
vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => mockUseIntegrations(),
	useCreateByoApiKey: () => ({ mutateAsync: mockCreate, isPending: false }),
	useCredentialAuditLog: () => mockUseAuditLog(),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'actor-1', name: 'Magnus', type: 'human' },
			{ id: 'agent-1', name: 'Infra & DevOps', type: 'agent' },
		],
	}),
}))

import { Route as LayoutRoute } from '@/routes/_authed/$workspaceId/settings/keychain'
import { Route as DetailRoute } from '@/routes/_authed/$workspaceId/settings/keychain/$integrationId'
import { Route as ListRoute } from '@/routes/_authed/$workspaceId/settings/keychain/index'
import { Route as NewRoute } from '@/routes/_authed/$workspaceId/settings/keychain/new'

const Layout = (LayoutRoute as unknown as { component: React.FC }).component
const KeychainPage = (ListRoute as unknown as { component: React.FC }).component
const AddCredentialPage = (NewRoute as unknown as { component: React.FC }).component
const CredentialDetailPage = (DetailRoute as unknown as { component: React.FC }).component

// Obviously fake. Built at runtime so no token-shaped literal sits in the repo.
const SECRET = `lin_${'CANARY0123'.repeat(4)}`

const pasted = (over = {}) =>
	buildIntegrationResponse({
		id: 'cred-paste',
		provider: 'custom',
		providerMode: 'byo_apikey',
		displayName: 'Linear · Sindre AI',
		source: 'admin_ui',
		scopeGrants: [{ kind: 'actor', actorId: 'actor-1' }],
		createdAt: '2026-10-04T10:00:00.000Z',
		...over,
	})
const captured = (over = {}) =>
	buildIntegrationResponse({
		id: 'cred-chat',
		provider: 'cloudflare',
		providerMode: 'byo_apikey',
		displayName: 'Cloudflare deploy',
		source: 'chat_capture',
		originSessionId: '9f2a3c1d-0000-4000-8000-000000000000',
		status: 'pending_undo',
		scopeGrants: [{ kind: 'actor', actorId: 'agent-1' }],
		createdAt: '2026-10-04T11:00:00.000Z',
		...over,
	})

beforeEach(() => {
	vi.clearAllMocks()
	mockFlag.mockReturnValue(true)
	mockParams.mockReturnValue({})
	mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
})

describe('Keychain layout route', () => {
	it('renders the child page when the flag is on', () => {
		render(<Layout />)
		expect(screen.getByText('child route')).toBeInTheDocument()
	})

	it('answers not found when the flag is off', () => {
		mockFlag.mockReturnValue(false)
		render(<Layout />)
		expect(screen.getByText('Page not found')).toBeInTheDocument()
		expect(screen.queryByText('child route')).not.toBeInTheDocument()
	})
})

describe('KeychainPage', () => {
	it('names the three paths and offers the first add when there are no credentials', () => {
		render(<KeychainPage />)
		expect(
			screen.getByRole('heading', { name: 'One place for every credential your agents need' }),
		).toBeInTheDocument()
		expect(screen.getByText('Paste')).toBeInTheDocument()
		expect(screen.getByText('OAuth')).toBeInTheDocument()
		expect(screen.getByText(/Chat capture/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Add your first credential/ })).toHaveAttribute(
			'href',
			'/$workspaceId/settings/keychain/new',
		)
	})

	it('lists held credentials newest first, with who can read each and the chat badge only where it applies', () => {
		mockUseIntegrations.mockReturnValue({
			data: [
				pasted(),
				captured(),
				// Not Keychain rows: a registered provider, and a key that was undone.
				buildIntegrationResponse({ id: 'slack', provider: 'slack', providerMode: 'registered' }),
				pasted({ id: 'gone', displayName: 'Undone key', status: 'undone' }),
			],
			isLoading: false,
		})
		render(<KeychainPage />)

		const rows = screen
			.getAllByRole('link')
			.filter((l) => l.getAttribute('href')?.endsWith('$integrationId'))
		expect(rows).toHaveLength(2)
		expect(rows[0]).toHaveTextContent('Cloudflare deploy')
		expect(rows[0]).toHaveTextContent('Captured via chat')
		expect(rows[0]).toHaveTextContent('Infra & DevOps')
		expect(rows[1]).toHaveTextContent('Linear · Sindre AI')
		expect(rows[1]).not.toHaveTextContent('Captured via chat')
		expect(rows[1]).toHaveTextContent('Magnus')
		expect(screen.queryByText('Undone key')).not.toBeInTheDocument()
		expect(screen.queryByText(/slack/i)).not.toBeInTheDocument()
		// The footer helper line appears because a chat-captured row is on the page.
		expect(screen.getByText(/were vaulted from a live session/)).toBeInTheDocument()
	})

	it('marks a credential nobody can read as unassigned and fail-closed', () => {
		mockUseIntegrations.mockReturnValue({ data: [pasted({ scopeGrants: [] })], isLoading: false })
		render(<KeychainPage />)
		expect(screen.getByText('Unassigned')).toBeInTheDocument()
		expect(screen.getByText(/No agents — fail-closed/)).toBeInTheDocument()
	})

	it('leaves the chat helper line out when nothing was captured via chat', () => {
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		render(<KeychainPage />)
		expect(screen.queryByText(/were vaulted from a live session/)).not.toBeInTheDocument()
	})

	it('shows no empty state while the list is loading', () => {
		mockUseIntegrations.mockReturnValue({ data: undefined, isLoading: true })
		render(<KeychainPage />)
		expect(screen.queryByText(/One place for every credential/)).not.toBeInTheDocument()
	})
})

describe('AddCredentialPage', () => {
	it('shows the three entry cards, with chat capture linking to chats and OAuth not selectable', () => {
		render(<AddCredentialPage />)
		expect(screen.getByText('Paste a secret')).toBeInTheDocument()
		expect(screen.getByText('Connect via OAuth').closest('li')).toHaveAttribute(
			'aria-disabled',
			'true',
		)
		expect(screen.getByRole('link', { name: /Capture from a chat/ })).toHaveAttribute(
			'href',
			'/$workspaceId/chats',
		)
	})

	it('cannot save until a name and a secret are both there', async () => {
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		const save = screen.getByRole('button', { name: 'Save' })
		expect(save).toBeDisabled()
		await user.type(screen.getByLabelText('Secret'), SECRET)
		expect(save).toBeDisabled()
		await user.type(screen.getByLabelText('Name'), '   ')
		expect(save).toBeDisabled()
		await user.type(screen.getByLabelText('Name'), 'Linear')
		expect(save).toBeEnabled()
	})

	it('masks the secret until Show is pressed', async () => {
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		const field = screen.getByLabelText('Secret')
		expect(field).toHaveAttribute('type', 'password')
		await user.click(screen.getByRole('button', { name: 'Show' }))
		expect(field).toHaveAttribute('type', 'text')
		expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-pressed', 'true')
	})

	it('sends the trimmed name and the secret, clears the field and opens the new credential', async () => {
		mockCreate.mockResolvedValue({ integrationId: 'new-id' })
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		await user.type(screen.getByLabelText('Name'), '  Linear · Sindre AI  ')
		await user.type(screen.getByLabelText('Secret'), SECRET)
		// The value lives in component state only: never in either web storage.
		expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET)
		expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET)

		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() =>
			expect(mockCreate).toHaveBeenCalledWith({
				displayName: 'Linear · Sindre AI',
				rawSecret: SECRET,
			}),
		)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/settings/keychain/$integrationId',
			params: { workspaceId: 'ws-1', integrationId: 'new-id' },
		})
		expect(screen.getByLabelText('Secret')).toHaveValue('')
	})

	it('saves on Enter in the name field too', async () => {
		mockCreate.mockResolvedValue({ integrationId: 'new-id' })
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		await user.type(screen.getByLabelText('Secret'), SECRET)
		await user.type(screen.getByLabelText('Name'), 'Linear{Enter}')
		await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
	})

	it('shows a plain message, keeps the form and does not navigate when saving fails', async () => {
		mockCreate.mockRejectedValue(new ApiError(400, 'Invalid fields: displayName'))
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		await user.type(screen.getByLabelText('Name'), 'Linear')
		await user.type(screen.getByLabelText('Secret'), SECRET)
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(
			await screen.findByText(
				'Could not save this credential. Check the name and secret, then try again.',
			),
		).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.getByLabelText('Secret')).toHaveValue(SECRET)
	})
})

function auditPage(entries: Partial<CredentialAuditEntry>[], next: string | null = null) {
	return {
		integrationId: 'x',
		source: 'admin_ui',
		originSessionId: null,
		nextBeforeId: next,
		entries: entries.map((e, i) => ({
			id: String(100 - i),
			actorId: 'actor-1',
			sessionId: null,
			outboundTarget: null,
			action: 'create',
			source: 'admin_ui',
			readAt: '2026-10-04T10:00:00.000Z',
			...e,
		})),
	} satisfies CredentialAuditLogPage
}

function auditLog(pages: CredentialAuditLogPage[], extra = {}) {
	return {
		data: { pages },
		isLoading: false,
		isError: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		...extra,
	}
}

describe('CredentialDetailPage', () => {
	it('says not found for an id that is not a held credential', () => {
		mockParams.mockReturnValue({ integrationId: 'slack' })
		mockUseAuditLog.mockReturnValue(auditLog([]))
		mockUseIntegrations.mockReturnValue({
			data: [buildIntegrationResponse({ id: 'slack', providerMode: 'registered' })],
			isLoading: false,
		})
		render(<CredentialDetailPage />)
		expect(screen.getByText('Credential not found')).toBeInTheDocument()
	})

	it('shows the chat chip, the CREATE via chat audit row with its session, and the details', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-chat' })
		mockUseIntegrations.mockReturnValue({ data: [captured()], isLoading: false })
		mockUseAuditLog.mockReturnValue(
			auditLog([
				auditPage([
					{
						action: 'read',
						source: 'chat_capture',
						actorId: 'agent-1',
						sessionId: 'aaaaaaaa-1',
						outboundTarget: 'api.cloudflare.com',
					},
					{
						action: 'create',
						source: 'chat_capture',
						sessionId: '9f2a3c1d-0000-4000-8000-000000000000',
					},
				]),
			]),
		)
		render(<CredentialDetailPage />)

		expect(screen.getByRole('heading', { name: 'Cloudflare deploy' })).toBeInTheDocument()
		expect(screen.getAllByText(/Captured via chat/).length).toBeGreaterThan(0)

		const log = screen.getByRole('region', { name: 'Audit log' })
		const items = within(log).getAllByRole('listitem')
		expect(items).toHaveLength(2)
		expect(items[0]).toHaveTextContent('Infra & DevOps read this credential for session aaaaaaaa')
		expect(items[0]).toHaveTextContent('api.cloudflare.com')
		expect(items[0]).toHaveTextContent('READ')
		expect(items[1]).toHaveTextContent('Captured via chat in session 9f2a3c1d')
		expect(items[1]).toHaveTextContent('vaulted, redacted from transcript')
		expect(items[1]).toHaveTextContent('CREATE')

		const details = screen.getByRole('region', { name: 'Details' })
		expect(details).toHaveTextContent('Cloudflare')
		expect(details).toHaveTextContent('API key')
		expect(details).toHaveTextContent('via chat')
		expect(details).toHaveTextContent('Infra & DevOps')
	})

	it('shows a pasted key without the chat chip and with a plain create row', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
		render(<CredentialDetailPage />)

		expect(screen.queryByText(/Captured via chat/)).not.toBeInTheDocument()
		expect(screen.getByText('Magnus added this credential.')).toBeInTheDocument()
		expect(screen.getByRole('region', { name: 'Details' })).toHaveTextContent('Custom')
	})

	it('loads more entries on request', async () => {
		const fetchNextPage = vi.fn()
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(
			auditLog([auditPage([{ action: 'create' }], '99')], { hasNextPage: true, fetchNextPage }),
		)
		const user = userEvent.setup()
		render(<CredentialDetailPage />)
		await user.click(screen.getByRole('button', { name: 'Load more entries' }))
		expect(fetchNextPage).toHaveBeenCalledTimes(1)
	})

	it('says so when the audit log cannot load, without hiding the credential', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([], { isError: true, data: undefined }))
		render(<CredentialDetailPage />)
		expect(screen.getByRole('alert')).toHaveTextContent('Could not load the audit log.')
		expect(screen.getByRole('heading', { name: 'Linear · Sindre AI' })).toBeInTheDocument()
	})
})
