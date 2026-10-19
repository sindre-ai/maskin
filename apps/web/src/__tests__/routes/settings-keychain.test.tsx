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

const mockRole = vi.fn<() => string>(() => 'member')
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { role: mockRole() }, workspaceId: 'ws-1' }),
}))

const mockActor = vi.fn<() => { id: string; type: string } | null>(() => ({
	id: 'actor-1',
	type: 'human',
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/auth')>()),
	getStoredActor: () => mockActor(),
}))

const mockFlag = vi.fn<() => boolean>(() => true)
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => mockFlag() }))
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: () => {} }))

const mockUseIntegrations = vi.fn()
const mockCreate = vi.fn()
const mockCreateLogin = vi.fn()
const mockRemove = vi.fn()
const mockRemoveReset = vi.fn()
const removeState = vi.fn<() => Record<string, unknown>>(() => ({}))
const mockUseAuditLog = vi.fn()
const mockUpdateScope = vi.fn()
const mockResetScope = vi.fn()
const scopeMutation = vi.fn<() => Record<string, unknown>>(() => ({}))
vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => mockUseIntegrations(),
	useCreateByoApiKey: () => ({ mutateAsync: mockCreate, isPending: false }),
	useCreateByoLogin: () => ({ mutateAsync: mockCreateLogin, isPending: false }),
	useRemoveCredential: () => ({
		mutate: mockRemove,
		reset: mockRemoveReset,
		isPending: false,
		isError: false,
		...removeState(),
	}),
	useCredentialAuditLog: () => mockUseAuditLog(),
	useUpdateKeyScope: () => ({
		mutate: mockUpdateScope,
		reset: mockResetScope,
		isPending: false,
		isError: false,
		error: null,
		...scopeMutation(),
	}),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'actor-1', name: 'Magnus', type: 'human' },
			{ id: 'agent-1', name: 'Infra & DevOps', type: 'agent' },
			{ id: 'agent-2', name: 'Code Reviewer', type: 'agent' },
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
	mockRole.mockReturnValue('member')
	mockActor.mockReturnValue({ id: 'actor-1', type: 'human' })
	scopeMutation.mockReturnValue({})
	removeState.mockReturnValue({})
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

	it('says the list could not load instead of showing the first-run empty state', () => {
		const refetch = vi.fn()
		mockUseIntegrations.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('boom'),
			refetch,
		})
		render(<KeychainPage />)
		expect(screen.getByText("Couldn't load your credentials")).toBeInTheDocument()
		expect(
			screen.queryByRole('heading', { name: 'One place for every credential your agents need' }),
		).not.toBeInTheDocument()
	})

	it('shows no empty state while the list is loading', () => {
		mockUseIntegrations.mockReturnValue({ data: undefined, isLoading: true })
		render(<KeychainPage />)
		expect(screen.queryByText(/One place for every credential/)).not.toBeInTheDocument()
	})
})

describe('AddCredentialPage', () => {
	it('shows the two entry cards, with chat capture linking to chats', () => {
		render(<AddCredentialPage />)
		expect(screen.getByText('Paste a secret')).toBeInTheDocument()
		expect(screen.queryByText('Connect via OAuth')).not.toBeInTheDocument()
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

	describe('Login type', () => {
		// A quote, a backslash, an apostrophe and non-ASCII: all fine in a password.
		const PASSWORD = String.raw`pw"with\odd'chars-æøå`

		async function switchToLogin(user: ReturnType<typeof userEvent.setup>) {
			await user.click(screen.getByRole('tab', { name: 'Login' }))
		}

		it('swaps the secret field for a username and a masked password', async () => {
			const user = userEvent.setup()
			render(<AddCredentialPage />)
			await switchToLogin(user)

			expect(screen.queryByLabelText('Secret')).not.toBeInTheDocument()
			expect(screen.getByLabelText('Username or email')).toBeInTheDocument()
			expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
		})

		it('cannot save until a name, a username and a password are all there', async () => {
			const user = userEvent.setup()
			render(<AddCredentialPage />)
			await switchToLogin(user)
			const save = screen.getByRole('button', { name: 'Save' })

			await user.type(screen.getByLabelText('Name'), 'e-conomic')
			await user.type(screen.getByLabelText('Username or email'), 'me@example.test')
			expect(save).toBeDisabled()
			await user.type(screen.getByLabelText('Password'), PASSWORD)
			expect(save).toBeEnabled()
		})

		it('sends the login to the login endpoint, not the key one, and clears the password', async () => {
			mockCreateLogin.mockResolvedValue({ integrationId: 'login-id' })
			const user = userEvent.setup()
			render(<AddCredentialPage />)
			await switchToLogin(user)
			await user.type(screen.getByLabelText('Name'), '  e-conomic  ')
			await user.type(screen.getByLabelText('Username or email'), '  me@example.test  ')
			await user.type(screen.getByLabelText('Password'), PASSWORD)
			expect(JSON.stringify({ ...localStorage })).not.toContain(PASSWORD)
			expect(JSON.stringify({ ...sessionStorage })).not.toContain(PASSWORD)

			await user.click(screen.getByRole('button', { name: 'Save' }))

			await waitFor(() =>
				expect(mockCreateLogin).toHaveBeenCalledWith({
					displayName: 'e-conomic',
					username: 'me@example.test',
					password: PASSWORD,
				}),
			)
			expect(mockCreate).not.toHaveBeenCalled()
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/$workspaceId/settings/keychain/$integrationId',
				params: { workspaceId: 'ws-1', integrationId: 'login-id' },
			})
			expect(screen.getByLabelText('Password')).toHaveValue('')
		})
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

	it('shows the server message when the name is taken, and keeps the form', async () => {
		const taken = new ApiError(409, 'Another key in this workspace already has this name.')
		taken.code = 'NAME_TAKEN'
		mockCreate.mockRejectedValue(taken)
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		await user.type(screen.getByLabelText('Name'), 'Linear')
		await user.type(screen.getByLabelText('Secret'), SECRET)
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(
			await screen.findByText('Another key in this workspace already has this name.'),
		).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
		expect(screen.getByLabelText('Secret')).toHaveValue(SECRET)
	})

	it('refuses a name the server would refuse, before any request', async () => {
		const user = userEvent.setup()
		render(<AddCredentialPage />)
		const name = screen.getByLabelText('Name')
		await user.click(name)
		// Pasted, because typing treats square brackets as key names.
		await user.paste('bad [name]')
		await user.type(screen.getByLabelText('Secret'), SECRET)
		expect(
			screen.getByText("Names can't contain square brackets or control characters."),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		expect(mockCreate).not.toHaveBeenCalled()
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

	it('says No reads yet when a credential has no audit rows', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([])]))
		render(<CredentialDetailPage />)
		expect(screen.getByText('No reads yet')).toBeInTheDocument()
	})

	it('says No reads yet under the created row when nothing has read the credential', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
		render(<CredentialDetailPage />)
		expect(screen.getByText('Magnus added this credential.')).toBeInTheDocument()
		expect(screen.getByText('No reads yet')).toBeInTheDocument()
	})

	it('does not say No reads yet once a read row exists', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(
			auditLog([auditPage([{ action: 'read', actorId: 'agent-1', sessionId: 'aaaaaaaa-1' }])]),
		)
		render(<CredentialDetailPage />)
		expect(screen.queryByText('No reads yet')).not.toBeInTheDocument()
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

describe('CredentialDetailPage: who can use this key', () => {
	function openPasted(over = {}) {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted(over)], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
		return render(<CredentialDetailPage />)
	}
	const agentsBlock = () =>
		screen.getByRole('heading', { name: 'Agents' }).parentElement?.parentElement

	it('lists the agents the key is granted to, and says so when there are none', () => {
		openPasted({ scopeGrants: [{ kind: 'actor', actorId: 'agent-1' }] })
		expect(agentsBlock()).toHaveTextContent('Available to 1 agent')
		expect(agentsBlock()).toHaveTextContent('Infra & DevOps')
	})

	it('says no agent can use a key granted to nobody but a person', () => {
		openPasted()
		expect(agentsBlock()).toHaveTextContent('No agent can use this key yet.')
	})

	it('names the whole workspace for a workspace grant', () => {
		openPasted({ scopeGrants: [{ kind: 'workspace' }] })
		expect(agentsBlock()).toHaveTextContent('Available to 2 agents')
		expect(agentsBlock()).toHaveTextContent('All agents in this workspace')
	})

	it('shows Edit access to the person who saved the key, and to an admin', () => {
		const { unmount } = openPasted()
		expect(screen.getByRole('button', { name: 'Edit access' })).toBeInTheDocument()
		unmount()
		mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
		mockRole.mockReturnValue('admin')
		openPasted()
		expect(screen.getByRole('button', { name: 'Edit access' })).toBeInTheDocument()
	})

	it('hides Edit access from a plain member, an agent and a key that is not active', () => {
		mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
		const { unmount } = openPasted()
		expect(screen.queryByRole('button', { name: 'Edit access' })).not.toBeInTheDocument()
		unmount()

		mockActor.mockReturnValue({ id: 'actor-1', type: 'agent' })
		mockRole.mockReturnValue('owner')
		const second = openPasted()
		expect(screen.queryByRole('button', { name: 'Edit access' })).not.toBeInTheDocument()
		second.unmount()

		mockActor.mockReturnValue({ id: 'actor-1', type: 'human' })
		mockParams.mockReturnValue({ integrationId: 'cred-chat' })
		mockUseIntegrations.mockReturnValue({ data: [captured()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
		render(<CredentialDetailPage />)
		expect(screen.queryByRole('button', { name: 'Edit access' })).not.toBeInTheDocument()
		expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument()
	})

	describe('Remove credential', () => {
		it('is offered to the person who saved it and to an admin, for a key and for a login', () => {
			const { unmount } = openPasted()
			expect(screen.getByRole('button', { name: 'Remove credential' })).toBeInTheDocument()
			unmount()

			mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
			mockRole.mockReturnValue('admin')
			const second = openPasted()
			expect(screen.getByRole('button', { name: 'Remove credential' })).toBeInTheDocument()
			second.unmount()

			mockActor.mockReturnValue({ id: 'actor-1', type: 'human' })
			mockRole.mockReturnValue('member')
			mockParams.mockReturnValue({ integrationId: 'cred-login' })
			mockUseIntegrations.mockReturnValue({
				data: [pasted({ id: 'cred-login', providerMode: 'byo_login', displayName: 'e-conomic' })],
				isLoading: false,
			})
			mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
			render(<CredentialDetailPage />)
			expect(screen.getByRole('button', { name: 'Remove credential' })).toBeInTheDocument()
		})

		it('is offered even inside the undo window, because removing is allowed at any time', () => {
			mockParams.mockReturnValue({ integrationId: 'cred-chat' })
			mockUseIntegrations.mockReturnValue({ data: [captured()], isLoading: false })
			mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
			render(<CredentialDetailPage />)
			expect(screen.getByRole('button', { name: 'Remove credential' })).toBeInTheDocument()
		})

		it('is hidden from a plain member who did not save it, and from an agent', () => {
			mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
			const { unmount } = openPasted()
			expect(screen.queryByRole('button', { name: 'Remove credential' })).not.toBeInTheDocument()
			unmount()

			mockActor.mockReturnValue({ id: 'actor-1', type: 'agent' })
			mockRole.mockReturnValue('owner')
			openPasted()
			expect(screen.queryByRole('button', { name: 'Remove credential' })).not.toBeInTheDocument()
		})

		it('is hidden for an OAuth connection, which is disconnected on the Integrations page', () => {
			mockParams.mockReturnValue({ integrationId: 'cred-oauth' })
			mockUseIntegrations.mockReturnValue({
				data: [pasted({ id: 'cred-oauth', providerMode: 'byo_oauth' })],
				isLoading: false,
			})
			mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'create' }])]))
			render(<CredentialDetailPage />)
			expect(screen.queryByRole('button', { name: 'Remove credential' })).not.toBeInTheDocument()
		})

		it('asks first, says the secret is destroyed, and removes nothing on Cancel', async () => {
			const user = userEvent.setup()
			openPasted()

			await user.click(screen.getByRole('button', { name: 'Remove credential' }))

			const dialog = await screen.findByRole('dialog')
			expect(within(dialog).getByText(/can't be recovered/)).toBeInTheDocument()
			await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
			expect(mockRemove).not.toHaveBeenCalled()
		})

		it('removes the credential on confirm and goes back to the list', async () => {
			mockRemove.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) =>
				opts?.onSuccess?.(),
			)
			const user = userEvent.setup()
			openPasted()

			await user.click(screen.getByRole('button', { name: 'Remove credential' }))
			await user.click(
				within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
			)

			expect(mockRemove).toHaveBeenCalledWith('cred-paste', expect.any(Object))
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/$workspaceId/settings/keychain',
				params: { workspaceId: 'ws-1' },
			})
		})

		it('keeps the dialog open and says so when removing fails', async () => {
			removeState.mockReturnValue({ isError: true })
			const user = userEvent.setup()
			openPasted()

			await user.click(screen.getByRole('button', { name: 'Remove credential' }))

			expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove this credential')
			expect(mockNavigate).not.toHaveBeenCalled()
		})
	})

	it('saves the ticked agent from the sheet', async () => {
		const user = userEvent.setup()
		openPasted()
		await user.click(screen.getByRole('button', { name: 'Edit access' }))
		await user.click(screen.getByRole('checkbox', { name: 'Code Reviewer' }))
		await user.click(screen.getByRole('button', { name: 'Save access' }))
		// The pasting person's own grant stays; only the agent is added.
		expect(mockUpdateScope).toHaveBeenCalledWith(
			[
				{ kind: 'actor', actorId: 'actor-1' },
				{ kind: 'actor', actorId: 'agent-2' },
			],
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('shows the failure inside the sheet and keeps it open', async () => {
		scopeMutation.mockReturnValue({ isError: true, error: new ApiError(500, 'boom') })
		const user = userEvent.setup()
		openPasted()
		await user.click(screen.getByRole('button', { name: 'Edit access' }))
		expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save access. Nothing changed.")
	})

	it('shows the audit row for a scope change with who made it', () => {
		mockParams.mockReturnValue({ integrationId: 'cred-paste' })
		mockUseIntegrations.mockReturnValue({ data: [pasted()], isLoading: false })
		mockUseAuditLog.mockReturnValue(auditLog([auditPage([{ action: 'scope_changed' }])]))
		render(<CredentialDetailPage />)
		const log = screen.getByRole('region', { name: 'Audit log' })
		const row = within(log).getAllByRole('listitem')[0]
		expect(row).toHaveTextContent('Magnus changed which agents can use this credential.')
		expect(row).toHaveTextContent('SCOPE CHANGED')
	})
})
