import { parseMcpJson } from '@/components/integrations/import-mcp-dialog'
import {
	ToolServerAccess,
	summarizeToolServerAccess,
	toolServerEnabled,
} from '@/components/integrations/tool-server-access'
import { ToolsSection } from '@/components/integrations/tools-section'
import type { IntegrationResponse } from '@/lib/api'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const AGENTS = [
	{ id: 'agent-1', name: 'Infra & DevOps', type: 'agent' },
	{ id: 'agent-2', name: 'Code Reviewer', type: 'agent' },
	{ id: 'human-1', name: 'Magnus', type: 'human' },
]
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: AGENTS }) }))

let integrations: IntegrationResponse[] = []
const setGrant = vi.fn()
const removeGrant = vi.fn()
const setDefault = vi.fn()
const createServer = vi.fn()
const removeServer = vi.fn()
vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: integrations }),
	useSetAgentGrant: () => ({ mutate: setGrant, isPending: false }),
	useRemoveAgentGrant: () => ({ mutate: removeGrant, isPending: false }),
	useSetDefaultAgentAccess: () => ({ mutate: setDefault, isPending: false }),
	useCreateCustomMcpServer: () => ({
		mutate: createServer,
		mutateAsync: createServer,
		isPending: false,
		error: null,
		reset: vi.fn(),
	}),
	useRemoveCustomMcpServer: () => ({ mutate: removeServer, isPending: false }),
	useCustomMcpServer: () => ({ data: undefined, isLoading: true, error: null }),
	useUpdateCustomMcpServer: () => ({
		mutate: vi.fn(),
		isPending: false,
		error: null,
		reset: vi.fn(),
	}),
}))

let role = 'member'
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspace: { role }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'human-1', type: 'human' }) }))

function server(over: Partial<IntegrationResponse> = {}) {
	return buildIntegrationResponse({
		id: 'srv-1',
		provider: 'custom-mcp',
		displayName: 'Docs search',
		createdBy: 'human-1',
		defaultAgentAccess: 'none',
		agentGrants: [],
		config: {
			custom_mcp: { transport: 'http', target: 'https://tools.example.com/mcp', gated: false },
		},
		...over,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	role = 'member'
	integrations = []
})

describe('toolServerEnabled / summarizeToolServerAccess', () => {
	it('uses the agent’s own entry, else the default', () => {
		expect(toolServerEnabled('none', undefined)).toBe(false)
		expect(toolServerEnabled('read', undefined)).toBe(true)
		expect(toolServerEnabled('read', { access: 'none' })).toBe(false)
		expect(toolServerEnabled('none', { access: 'read_write' })).toBe(true)
	})

	it('summarises who has the server', () => {
		const ids = ['a', 'b', 'c']
		expect(summarizeToolServerAccess('none', [], ids)).toBe('No agents use it yet')
		expect(summarizeToolServerAccess('none', [{ actorId: 'a', access: 'read_write' }], ids)).toBe(
			'1 of 3 agents',
		)
		expect(summarizeToolServerAccess('read', [], ids)).toBe('All agents')
		expect(summarizeToolServerAccess('read', [{ actorId: 'b', access: 'none' }], ids)).toBe(
			'2 of 3 agents',
		)
		expect(summarizeToolServerAccess('read', [], [])).toBe('No agents yet')
	})
})

describe('ToolsSection', () => {
	it('always shows Maskin as read & write and always on, with nothing to change', () => {
		render(<ToolsSection workspaceId="ws-1" />)
		const region = screen.getByRole('region', { name: 'Custom tools' })
		expect(within(region).getByText('Maskin')).toBeInTheDocument()
		expect(within(region).getByText(/Read & write · always on/)).toBeInTheDocument()
		expect(within(region).queryByRole('switch')).not.toBeInTheDocument()
		expect(within(region).queryByText(/Every agent has it/)).toBeNull()
		expect(within(region).queryByText(/instead of setting it up on each agent/)).toBeNull()
	})

	it('lists each custom server with where it points, and none of the other integrations', () => {
		integrations = [server(), buildIntegrationResponse({ id: 'slack-1', provider: 'slack' })]
		render(<ToolsSection workspaceId="ws-1" />)
		expect(screen.getByText('Docs search')).toBeInTheDocument()
		expect(screen.getByText('HTTP · https://tools.example.com/mcp')).toBeInTheDocument()
		expect(screen.queryByText('slack')).not.toBeInTheDocument()
	})

	it('ignores a removed server', () => {
		integrations = [server({ status: 'revoked' })]
		render(<ToolsSection workspaceId="ws-1" />)
		expect(screen.queryByText('Docs search')).not.toBeInTheDocument()
	})

	it('saves a new http server from the form', async () => {
		const user = userEvent.setup()
		render(<ToolsSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('button', { name: /Add server/ }))
		await user.type(screen.getByLabelText('Name'), 'Docs search')
		await user.click(screen.getByRole('combobox', { name: 'Transport' }))
		await user.click(await screen.findByRole('option', { name: 'HTTP' }))
		await user.type(screen.getByLabelText('URL'), 'https://tools.example.com/mcp')
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(createServer).toHaveBeenCalledWith(
			{
				name: 'Docs search',
				server: { type: 'http', url: 'https://tools.example.com/mcp', headers: {} },
			},
			expect.anything(),
		)
	})

	it('lets a header point at a saved credential instead of pasting the secret', async () => {
		const user = userEvent.setup()
		integrations = [
			buildIntegrationResponse({
				id: 'key-1',
				provider: 'stripe',
				providerMode: 'byo_apikey',
				displayName: 'Stripe',
				status: 'active',
			}),
			buildIntegrationResponse({
				id: 'login-1',
				provider: 'coolify',
				providerMode: 'byo_login',
				displayName: 'Coolify',
				status: 'active',
			}),
		]
		render(<ToolsSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('button', { name: /Add server/ }))
		await user.type(screen.getByLabelText('Name'), 'Billing')
		await user.click(screen.getByRole('combobox', { name: 'Transport' }))
		await user.click(await screen.findByRole('option', { name: 'HTTP' }))
		await user.type(screen.getByLabelText('URL'), 'https://tools.example.com/mcp')
		await user.click(screen.getByRole('button', { name: /^Add$/ }))
		await user.type(screen.getByLabelText('Headers name'), 'Authorization')
		await user.type(screen.getByLabelText('Headers value'), 'Bearer ')

		await user.click(
			screen.getByRole('combobox', { name: /saved credential for headers Authorization/i }),
		)
		// An API key is one entry; a login is its username and its password.
		expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
			'Stripe',
			'Coolify · username',
			'Coolify · password',
		])
		await user.click(screen.getByRole('option', { name: 'Stripe' }))
		const reference = 'Bearer ${KEYCHAIN_BYO_APIKEY_STRIPE}'
		expect(screen.getByLabelText('Headers value')).toHaveValue(reference)
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(createServer).toHaveBeenCalledWith(
			{
				name: 'Billing',
				server: {
					type: 'http',
					url: 'https://tools.example.com/mcp',
					headers: { Authorization: reference },
				},
			},
			expect.anything(),
		)
	})

	it('offers no credential picker when nothing is saved in the Keychain', async () => {
		const user = userEvent.setup()
		render(<ToolsSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('button', { name: /Add server/ }))
		await user.click(screen.getByRole('button', { name: /^Add$/ }))
		expect(screen.queryByRole('combobox', { name: /saved credential/i })).toBeNull()
	})

	it('asks before removing a server', async () => {
		const user = userEvent.setup()
		integrations = [server()]
		render(<ToolsSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('button', { name: 'Remove Docs search' }))
		expect(removeServer).not.toHaveBeenCalled()
		await user.click(screen.getByRole('button', { name: 'Remove' }))
		expect(removeServer).toHaveBeenCalledWith('srv-1')
	})

	it('offers no edit, remove or add to someone who did not add it and is not an admin', () => {
		integrations = [server({ createdBy: 'someone-else' })]
		render(<ToolsSection workspaceId="ws-1" />)
		expect(screen.queryByRole('button', { name: 'Edit Docs search' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Remove Docs search' })).not.toBeInTheDocument()
	})

	it('disables the add controls for a viewer', () => {
		role = 'viewer'
		render(<ToolsSection workspaceId="ws-1" />, {
			wrapper: createWorkspaceWrapper({ role: 'viewer' }),
		})
		expect(screen.getByRole('button', { name: /Add server/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: /Import \.mcp\.json/ })).toBeDisabled()
	})
})

describe('ToolServerAccess', () => {
	async function renderOpen(over: Partial<IntegrationResponse> = {}) {
		const user = userEvent.setup()
		render(<ToolServerAccess integration={server(over)} workspaceId="ws-1" />)
		await user.click(screen.getByRole('button', { name: /Agents/ }))
		return user
	}

	it('lists the agents, not the people, each on or off', async () => {
		await renderOpen({ agentGrants: [{ actorId: 'agent-1', access: 'read_write' }] })
		expect(screen.getByRole('switch', { name: 'Docs search for Infra & DevOps' })).toBeChecked()
		expect(screen.getByRole('switch', { name: 'Docs search for Code Reviewer' })).not.toBeChecked()
		expect(screen.queryByText('Magnus')).not.toBeInTheDocument()
	})

	it('turns an agent on with a read & write grant', async () => {
		const user = await renderOpen()
		await user.click(screen.getByRole('switch', { name: 'Docs search for Code Reviewer' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-2', access: 'read_write' })
	})

	it('turns an agent off by removing its grant when the default is off', async () => {
		const user = await renderOpen({ agentGrants: [{ actorId: 'agent-1', access: 'read_write' }] })
		await user.click(screen.getByRole('switch', { name: 'Docs search for Infra & DevOps' }))
		expect(removeGrant).toHaveBeenCalledWith('agent-1')
	})

	it('turns every agent on through the default', async () => {
		const user = await renderOpen()
		await user.click(screen.getByRole('switch', { name: 'Docs search for all agents' }))
		expect(setDefault).toHaveBeenCalledWith('read')
	})

	it('turns one agent off with a No access grant when every agent has it', async () => {
		const user = await renderOpen({ defaultAgentAccess: 'read' })
		const toggle = screen.getByRole('switch', { name: 'Docs search for Code Reviewer' })
		expect(toggle).toBeChecked()
		await user.click(toggle)
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-2', access: 'none' })
	})

	it('is read-only for someone who did not add it and is not an admin', async () => {
		await renderOpen({ createdBy: 'someone-else' })
		expect(screen.getByRole('switch', { name: 'Docs search for all agents' })).toBeDisabled()
		expect(screen.getByRole('switch', { name: 'Docs search for Code Reviewer' })).toBeDisabled()
	})
})

describe('ToolServerAccess for a server Maskin sits in front of', () => {
	it('has the Read / Read & write / No access controls of a built-in integration', async () => {
		const user = userEvent.setup()
		render(
			<ToolServerAccess
				integration={server({
					defaultAgentAccess: 'none',
					config: { custom_mcp: { transport: 'http', target: 'x', gated: true } },
				})}
				workspaceId="ws-1"
			/>,
		)
		await user.click(screen.getByRole('button', { name: /Agent access/ }))
		expect(
			screen.getByRole('combobox', { name: 'Access for all other agents' }),
		).toBeInTheDocument()
		expect(screen.queryByRole('switch')).toBeNull()
	})
})

describe('parseMcpJson', () => {
	it('returns the servers of a .mcp.json', () => {
		const result = parseMcpJson('{"mcpServers":{"a":{"command":"npx"}}}')
		expect(result).toEqual({ servers: { a: { command: 'npx' } } })
	})

	it('explains what is wrong', () => {
		expect(parseMcpJson('not json')).toEqual({ error: 'Invalid JSON' })
		expect(parseMcpJson('{"servers":{}}')).toEqual({
			error: 'Expected { "mcpServers": { ... } } format',
		})
	})
})
