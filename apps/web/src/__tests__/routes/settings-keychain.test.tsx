import { ApiError } from '@/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildIntegrationResponse } from '../factories'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
		Outlet: () => <p>child route</p>,
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

const mockRole = vi.fn<() => string>(() => 'member')
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
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

vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: () => {} }))

const mockUseIntegrations = vi.fn()
const mockCreate = vi.fn()
const mockCreateLogin = vi.fn()
const mockRemove = vi.fn()
const mockRemoveReset = vi.fn()
const removeState = vi.fn<() => Record<string, unknown>>(() => ({}))
const mockSetGrant = vi.fn()
const mockUpdate = vi.fn()
const updateState = vi.fn<() => Record<string, unknown>>(() => ({}))
const mockRemoveGrant = vi.fn()
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
	useUpdateCredential: () => ({
		mutate: mockUpdate,
		isPending: false,
		isError: false,
		error: null,
		...updateState(),
	}),
	useSetAgentGrant: () => ({ mutate: mockSetGrant, isPending: false }),
	useRemoveAgentGrant: () => ({ mutate: mockRemoveGrant, isPending: false }),
	useSetDefaultAgentAccess: () => ({ mutate: vi.fn(), isPending: false }),
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
import { Route as ListRoute } from '@/routes/_authed/$workspaceId/settings/keychain/index'
import { Route as NewRoute } from '@/routes/_authed/$workspaceId/settings/keychain/new'

const Layout = (LayoutRoute as unknown as { component: React.FC }).component
const KeychainPage = (ListRoute as unknown as { component: React.FC }).component
const AddCredentialPage = (NewRoute as unknown as { component: React.FC }).component

// Obviously fake. Built at runtime so no token-shaped literal sits in the repo.
const SECRET = `lin_${'CANARY0123'.repeat(4)}`

const pasted = (over = {}) =>
	buildIntegrationResponse({
		id: 'cred-paste',
		provider: 'custom',
		providerMode: 'byo_apikey',
		displayName: 'Linear · Sindre AI',
		source: 'admin_ui',
		agentGrants: [],
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
		agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		createdAt: '2026-10-04T11:00:00.000Z',
		...over,
	})

beforeEach(() => {
	vi.clearAllMocks()
	mockUseIntegrations.mockReturnValue({ data: [], isLoading: false })
	mockRole.mockReturnValue('member')
	mockActor.mockReturnValue({ id: 'actor-1', type: 'human' })
	removeState.mockReturnValue({})
	updateState.mockReturnValue({})
})

describe('Keychain layout route', () => {
	it('renders the child page', () => {
		render(<Layout />)
		expect(screen.getByText('child route')).toBeInTheDocument()
	})
})

describe('KeychainPage', () => {
	it('sorts credentials A to Z by name, whichever was added last', () => {
		mockUseIntegrations.mockReturnValue({
			data: [
				pasted({ id: 'c-new', displayName: 'Zapier key', createdAt: '2026-10-10T10:00:00.000Z' }),
				pasted({ id: 'c-old', displayName: 'apple login', createdAt: '2026-10-01T10:00:00.000Z' }),
				pasted({ id: 'c-mid', displayName: 'Mailgun key', createdAt: '2026-10-05T10:00:00.000Z' }),
			],
			isLoading: false,
		})
		render(<KeychainPage />)

		const names = screen
			.getAllByText(/^(Zapier key|apple login|Mailgun key)$/)
			.map((n) => n.textContent)
		expect(names).toEqual(['apple login', 'Mailgun key', 'Zapier key'])
	})

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

	it('lists held credentials alphabetically as cards, with the chat caption only where it applies', () => {
		mockUseIntegrations.mockReturnValue({
			data: [
				pasted({ agentGrants: [{ actorId: 'agent-2', access: 'read_write' }] }),
				captured(),
				// Not Keychain rows: a registered provider, and a key that was undone.
				buildIntegrationResponse({ id: 'slack', provider: 'slack', providerMode: 'registered' }),
				pasted({ id: 'gone', displayName: 'Undone key', status: 'undone' }),
			],
			isLoading: false,
		})
		render(<KeychainPage />)

		const names = screen
			.getAllByText(/^(Cloudflare deploy|Linear · Sindre AI)$/)
			.map((n) => n.textContent)
		expect(names).toEqual(['Cloudflare deploy', 'Linear · Sindre AI'])
		expect(screen.getAllByText(/Captured via chat/)).toHaveLength(1)
		expect(screen.queryByText('Undone key')).not.toBeInTheDocument()
		expect(screen.queryByText(/slack/i)).not.toBeInTheDocument()
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

	it('sends the trimmed name and the secret, clears the field and goes back to the list', async () => {
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
			to: '/$workspaceId/settings/keychain',
			params: { workspaceId: 'ws-1' },
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

		it('takes one username-or-email value and sends no separate email', async () => {
			mockCreateLogin.mockResolvedValue({ integrationId: 'login-id' })
			const user = userEvent.setup()
			render(<AddCredentialPage />)
			await switchToLogin(user)
			expect(screen.queryByLabelText(/^Email/)).not.toBeInTheDocument()
			await user.type(screen.getByLabelText('Name'), 'Dinero')
			await user.type(screen.getByLabelText('Username or email'), 'me@example.test')
			await user.type(screen.getByLabelText('Password'), PASSWORD)

			await user.click(screen.getByRole('button', { name: 'Save' }))

			await waitFor(() =>
				expect(mockCreateLogin).toHaveBeenCalledWith({
					displayName: 'Dinero',
					username: 'me@example.test',
					password: PASSWORD,
				}),
			)
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
				to: '/$workspaceId/settings/keychain',
				params: { workspaceId: 'ws-1' },
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

describe('KeychainPage: credential cards', () => {
	const open = (over = {}, ...more: unknown[]) => {
		mockUseIntegrations.mockReturnValue({ data: [pasted(over), ...more], isLoading: false })
		return render(<KeychainPage />)
	}
	const agentAccess = () => screen.getByRole('button', { name: /Agent access/ })

	describe('Agent access', () => {
		it('starts collapsed with a one-line summary, and says plainly when no agent has the key', () => {
			open()
			expect(agentAccess()).toHaveAttribute('aria-expanded', 'false')
			expect(agentAccess()).toHaveTextContent('No agents have access')
		})

		it('counts the agents that can use the key', () => {
			open({
				agentGrants: [
					{ actorId: 'agent-1', access: 'read_write' },
					{ actorId: 'agent-2', access: 'read_write' },
				],
			})
			expect(agentAccess()).toHaveTextContent('2 agents have access')
		})

		it('says every agent has it when the default is Full access, and counts the ones set to No access', () => {
			open({
				defaultAgentAccess: 'read',
				agentGrants: [{ actorId: 'agent-1', access: 'none' }],
			})
			expect(agentAccess()).toHaveTextContent('All agents have access · 1 has no access')
		})

		it('lists the agents with an entry alphabetically, under an All other agents row', async () => {
			const user = userEvent.setup()
			open({
				agentGrants: [
					{ actorId: 'agent-1', access: 'read_write' },
					{ actorId: 'agent-2', access: 'read_write' },
				],
			})
			await user.click(agentAccess())

			const names = screen
				.getAllByText(/^(Code Reviewer|Infra & DevOps)$/)
				.map((n) => n.textContent)
			expect(names).toEqual(['Code Reviewer', 'Infra & DevOps'])
			expect(screen.getByText('All other agents')).toBeInTheDocument()
			expect(
				screen.getByRole('combobox', { name: 'Access for all other agents' }),
			).toHaveTextContent('No access')
			expect(screen.getByRole('combobox', { name: 'Access for Code Reviewer' })).toHaveTextContent(
				'Full access',
			)
			// Both agents already have an entry, so there is nobody left to add.
			expect(screen.queryByRole('combobox', { name: 'Add an agent' })).not.toBeInTheDocument()
			expect(
				screen.getByText(
					'Applies to new sessions. A session already running keeps the key until it ends.',
				),
			).toBeInTheDocument()
		})

		it('puts an agent back with the others when it is set to what they get', async () => {
			const user = userEvent.setup()
			open({ agentGrants: [{ actorId: 'agent-1', access: 'read_write' }] })
			await user.click(agentAccess())
			// No remove button: choosing the default's level is how an entry goes away.
			expect(
				screen.queryByRole('button', { name: 'Remove Infra & DevOps' }),
			).not.toBeInTheDocument()
			await user.click(screen.getByRole('combobox', { name: 'Access for Infra & DevOps' }))
			await user.click(await screen.findByRole('option', { name: 'No access' }))
			expect(mockRemoveGrant).toHaveBeenCalledWith('agent-1')
			expect(mockSetGrant).not.toHaveBeenCalled()
		})

		it('drops the entry when the default is Full access and the agent is set to Full access', async () => {
			const user = userEvent.setup()
			open({ defaultAgentAccess: 'read', agentGrants: [{ actorId: 'agent-1', access: 'none' }] })
			await user.click(agentAccess())
			await user.click(screen.getByRole('combobox', { name: 'Access for Infra & DevOps' }))
			await user.click(await screen.findByRole('option', { name: 'Full access' }))
			// Full access is the default here, so there is nothing of its own to keep.
			expect(mockRemoveGrant).toHaveBeenCalledWith('agent-1')
		})

		it('is read-only for a plain member who did not save the key', async () => {
			mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
			const user = userEvent.setup()
			open({ agentGrants: [{ actorId: 'agent-1', access: 'read_write' }] })
			await user.click(agentAccess())
			expect(
				screen.queryByRole('button', { name: 'Remove Infra & DevOps' }),
			).not.toBeInTheDocument()
			expect(screen.queryByRole('combobox', { name: 'Add an agent' })).not.toBeInTheDocument()
			expect(screen.getByText(/Only the person who saved this key/)).toBeInTheDocument()
		})

		it('is left out for a key still in its undo window and for an OAuth connection', () => {
			mockUseIntegrations.mockReturnValue({
				data: [captured(), pasted({ id: 'cred-oauth', providerMode: 'byo_oauth' })],
				isLoading: false,
			})
			render(<KeychainPage />)
			expect(screen.queryByRole('button', { name: /Agent access/ })).not.toBeInTheDocument()
		})
	})

	describe('Remove', () => {
		const removeButton = () => screen.queryByRole('button', { name: 'Remove Linear · Sindre AI' })

		it('is offered to the person who saved it and to an admin, for a key and for a login', () => {
			const { unmount } = open()
			expect(removeButton()).toBeInTheDocument()
			unmount()

			mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
			mockRole.mockReturnValue('admin')
			const second = open()
			expect(removeButton()).toBeInTheDocument()
			second.unmount()

			mockActor.mockReturnValue({ id: 'actor-1', type: 'human' })
			mockRole.mockReturnValue('member')
			open({ providerMode: 'byo_login' })
			expect(removeButton()).toBeInTheDocument()
		})

		it('is offered even inside the undo window, because removing is allowed at any time', () => {
			mockUseIntegrations.mockReturnValue({ data: [captured()], isLoading: false })
			render(<KeychainPage />)
			expect(screen.getByRole('button', { name: 'Remove Cloudflare deploy' })).toBeInTheDocument()
		})

		it('is hidden from a plain member who did not save it, and from an agent', () => {
			mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
			const { unmount } = open()
			expect(removeButton()).not.toBeInTheDocument()
			unmount()

			mockActor.mockReturnValue({ id: 'actor-1', type: 'agent' })
			mockRole.mockReturnValue('owner')
			open()
			expect(removeButton()).not.toBeInTheDocument()
		})

		it('is hidden for an OAuth connection, which is disconnected on the Integrations page', () => {
			open({ providerMode: 'byo_oauth' })
			expect(removeButton()).not.toBeInTheDocument()
		})

		it('asks first, says the secret is destroyed, and removes nothing on Cancel', async () => {
			const user = userEvent.setup()
			open()

			await user.click(removeButton() as HTMLElement)

			const dialog = await screen.findByRole('dialog')
			expect(within(dialog).getByText(/can't be recovered/)).toBeInTheDocument()
			await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
			expect(mockRemove).not.toHaveBeenCalled()
		})

		it('removes the credential on confirm and closes the dialog', async () => {
			mockRemove.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) =>
				opts?.onSuccess?.(),
			)
			const user = userEvent.setup()
			open()

			await user.click(removeButton() as HTMLElement)
			await user.click(
				within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
			)

			expect(mockRemove).toHaveBeenCalledWith('cred-paste', expect.any(Object))
			await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		})

		it('keeps the dialog open and says so when removing fails', async () => {
			removeState.mockReturnValue({ isError: true })
			const user = userEvent.setup()
			open()

			await user.click(removeButton() as HTMLElement)

			expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove this credential')
		})
	})
})

describe('KeychainPage: edit a credential', () => {
	const open = (over = {}) => {
		mockUseIntegrations.mockReturnValue({ data: [pasted(over)], isLoading: false })
		return render(<KeychainPage />)
	}
	const editButton = () => screen.queryByRole('button', { name: 'Edit Linear · Sindre AI' })
	const dialog = async () => within(await screen.findByRole('dialog'))
	const save = (d: ReturnType<typeof within>) => d.getByRole('button', { name: 'Save' })

	it('is offered to the person who saved it and to an admin, and hidden from everyone else', () => {
		const { unmount } = open()
		expect(editButton()).toBeInTheDocument()
		unmount()

		mockActor.mockReturnValue({ id: 'someone-else', type: 'human' })
		const plain = open()
		expect(editButton()).not.toBeInTheDocument()
		plain.unmount()

		mockRole.mockReturnValue('admin')
		open()
		expect(editButton()).toBeInTheDocument()
	})

	it('is hidden for an OAuth connection and for a key still in its undo window', () => {
		open({ providerMode: 'byo_oauth' })
		expect(editButton()).not.toBeInTheDocument()
		mockUseIntegrations.mockReturnValue({ data: [captured()], isLoading: false })
		render(<KeychainPage />)
		expect(screen.queryByRole('button', { name: 'Edit Cloudflare deploy' })).not.toBeInTheDocument()
	})

	it('starts on the saved name with an empty secret, and cannot save until something changes', async () => {
		const user = userEvent.setup()
		open()
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		expect(d.getByLabelText('Name')).toHaveValue('Linear · Sindre AI')
		expect(d.getByLabelText('New secret')).toHaveValue('')
		expect(save(d)).toBeDisabled()
	})

	it('renames without sending a secret, and warns that agents using the old name need the new one', async () => {
		const user = userEvent.setup()
		open()
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		const name = d.getByLabelText('Name')
		await user.clear(name)
		await user.type(name, 'Linear production')
		expect(d.getByText(/use this by its old name need the new one/)).toBeInTheDocument()
		await user.click(save(d))
		expect(mockUpdate).toHaveBeenCalledWith(
			{ displayName: 'Linear production' },
			expect.any(Object),
		)
	})

	it('replaces the key without renaming, and clears the field once saved', async () => {
		mockUpdate.mockImplementation((_b: unknown, opts?: { onSuccess?: () => void }) =>
			opts?.onSuccess?.(),
		)
		const user = userEvent.setup()
		open()
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		await user.type(d.getByLabelText('New secret'), SECRET)
		await user.click(save(d))
		expect(mockUpdate).toHaveBeenCalledWith({ rawSecret: SECRET }, expect.any(Object))
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET)
	})

	it('changes only the password of a login, without asking for the username again', async () => {
		const user = userEvent.setup()
		open({ providerMode: 'byo_login' })
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		expect(save(d)).toBeDisabled()
		await user.type(d.getByLabelText('New password'), 'p4ss"word')
		expect(save(d)).toBeEnabled()
		await user.click(save(d))
		expect(mockUpdate).toHaveBeenCalledWith({ password: 'p4ss"word' }, expect.any(Object))
	})

	it('changes only the username of a login', async () => {
		const user = userEvent.setup()
		open({ providerMode: 'byo_login' })
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		await user.type(d.getByLabelText('New username'), 'me@example.test')
		await user.click(save(d))
		expect(mockUpdate).toHaveBeenCalledWith({ username: 'me@example.test' }, expect.any(Object))
	})

	it('sets a username and an email together, and an email alone', async () => {
		const user = userEvent.setup()
		open({ providerMode: 'byo_login' })
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		await user.type(d.getByLabelText('New email'), 'me@work.test')
		expect(save(d)).toBeEnabled()
		await user.type(d.getByLabelText('New username'), 'me')
		await user.click(save(d))
		expect(mockUpdate).toHaveBeenCalledWith(
			{ username: 'me', email: 'me@work.test' },
			expect.any(Object),
		)
	})

	it('refuses a name the server would refuse, before any request', async () => {
		const user = userEvent.setup()
		open()
		await user.click(editButton() as HTMLElement)
		const d = await dialog()
		const name = d.getByLabelText('Name')
		await user.clear(name)
		await user.click(name)
		await user.paste('bad [name]')
		expect(
			d.getByText("Names can't contain square brackets or control characters."),
		).toBeInTheDocument()
		expect(save(d)).toBeDisabled()
	})

	it('shows the server message when the name is taken, and keeps the dialog open', async () => {
		const taken = new ApiError(409, 'Another key in this workspace already has this name.')
		taken.code = 'NAME_TAKEN'
		updateState.mockReturnValue({ isError: true, error: taken })
		const user = userEvent.setup()
		open()
		await user.click(editButton() as HTMLElement)
		expect(await screen.findByRole('alert')).toHaveTextContent('already has this name')
	})
})
