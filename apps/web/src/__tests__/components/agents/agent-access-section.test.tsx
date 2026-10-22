import { AgentAccessSection } from '@/components/agents/agent-access-section'
import type { ActorResponse, AgentAccessView } from '@/lib/api'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setGrant = vi.fn()
const removeGrant = vi.fn()
let view: AgentAccessView | undefined
vi.mock('@/hooks/use-integrations', () => ({
	useAgentAccess: () => ({ data: view }),
	useSetAgentGrant: () => ({ mutate: setGrant, isPending: false }),
	useRemoveAgentGrant: () => ({ mutate: removeGrant, isPending: false }),
}))

let role = 'member'
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { role }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'human-1', type: 'human' }) }))

const agent = { id: 'agent-1', name: 'Reviewer', type: 'agent' } as ActorResponse

function data(over: Partial<AgentAccessView> = {}): AgentAccessView {
	return {
		maskin_mcp: { name: 'Maskin', access: 'read_write', locked: true },
		integrations: [
			{
				integration_id: 'int-linear',
				provider: 'linear',
				name: 'Linear',
				access: 'read',
				source: 'default',
				default_access: 'read',
				server_attached: true,
				created_by: 'human-1',
				kind: 'integration',
				gated: false,
			},
		],
		credentials: [
			{
				integration_id: 'int-stripe',
				name: 'Stripe',
				kind: 'api_key',
				has_access: false,
				default_access: 'none',
				scope: null,
				chat_count: 0,
				created_by: 'human-1',
			},
		],
		...over,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	role = 'member'
	view = data()
})

describe('AgentAccessSection', () => {
	it('shows each tool and credential by name only, with no second line', () => {
		render(<AgentAccessSection agent={agent} />)
		expect(screen.getByText('Linear')).toBeInTheDocument()
		expect(screen.queryByText('Tools attached')).toBeNull()
		expect(screen.getByRole('combobox', { name: 'Access to Linear' })).toHaveTextContent(
			'Default (Read)',
		)
		expect(screen.getByText('Stripe')).toBeInTheDocument()
		expect(screen.queryByText(/API key/)).toBeNull()
	})

	it('reads an explicit grant by its level', () => {
		view = data({
			integrations: [
				{
					integration_id: 'int-linear',
					provider: 'linear',
					name: 'Linear',
					access: 'none',
					source: 'default',
					default_access: 'none',
					server_attached: false,
					created_by: 'human-1',
					kind: 'integration',
					gated: false,
				},
			],
		})
		render(<AgentAccessSection agent={agent} />)
		expect(screen.queryByText('No tools attached')).toBeNull()
		expect(screen.getByRole('combobox', { name: 'Access to Linear' })).toHaveTextContent(
			'Default (No access)',
		)
	})

	it('sets a level, or goes back to the default, through the same grant hooks as the other pages', async () => {
		const user = userEvent.setup()
		render(<AgentAccessSection agent={agent} />)
		await user.click(screen.getByRole('combobox', { name: 'Access to Linear' }))
		await user.click(await screen.findByRole('option', { name: 'Read & write' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'read_write' })

		view = data({
			integrations: [{ ...data().integrations[0], source: 'grant', access: 'read_write' }],
		})
		const second = render(<AgentAccessSection agent={agent} />)
		await user.click(second.getAllByRole('combobox', { name: 'Access to Linear' })[1])
		await user.click(await screen.findByRole('option', { name: 'Default (Read)' }))
		expect(removeGrant).toHaveBeenCalledWith('agent-1')
	})

	it('turns a saved credential on and off for this agent', async () => {
		const user = userEvent.setup()
		render(<AgentAccessSection agent={agent} />)
		await user.click(screen.getByRole('switch', { name: 'Stripe for this agent' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'read_write' })
	})

	it('takes an agent off an integration with No access, without touching the others', async () => {
		const user = userEvent.setup()
		render(<AgentAccessSection agent={agent} />)
		await user.click(screen.getByRole('combobox', { name: 'Access to Linear' }))
		await user.click(await screen.findByRole('option', { name: 'No access' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'none' })
	})

	it('offers Read, Read & write and No access, and no Write-only level', async () => {
		const user = userEvent.setup()
		render(<AgentAccessSection agent={agent} />)
		await user.click(screen.getByRole('combobox', { name: 'Access to Linear' }))
		const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
		expect(options).toEqual(['Default (Read)', 'Read', 'Read & write', 'No access'])
	})

	it('is read-only for someone who did not connect it and is not an admin', () => {
		view = data({
			integrations: [{ ...data().integrations[0], created_by: 'someone-else' }],
			credentials: [{ ...data().credentials[0], created_by: 'someone-else' }],
		})
		render(<AgentAccessSection agent={agent} />)
		expect(screen.getByRole('combobox', { name: 'Access to Linear' })).toBeDisabled()
		expect(screen.getByRole('switch', { name: 'Stripe for this agent' })).toBeDisabled()
	})

	it('labels the list Tools, with no separate Integrations label, and lists Maskin with nothing to switch', () => {
		view = data({ integrations: [], credentials: [] })
		render(<AgentAccessSection agent={agent} />)
		expect(screen.getByText('Tools', { selector: '.settings-label' })).toBeInTheDocument()
		expect(screen.queryByText('Integrations', { selector: '.settings-label' })).toBeNull()
		const tools = screen.getByRole('list', { name: 'Tools' })
		expect(within(tools).getByText('Maskin')).toBeInTheDocument()
		expect(within(tools).queryByText(/Every agent has it/)).toBeNull()
		expect(within(tools).getByText('Read & write')).toBeInTheDocument()
		expect(within(tools).queryByRole('switch')).not.toBeInTheDocument()
		expect(within(tools).queryByRole('combobox')).not.toBeInTheDocument()
	})

	describe('a custom tool server', () => {
		const server = (over: Record<string, unknown> = {}) => ({
			...data().integrations[0],
			integration_id: 'int-docs',
			provider: 'custom-mcp',
			name: 'Docs search',
			access: 'none' as const,
			source: 'default' as const,
			default_access: 'none' as const,
			kind: 'tool_server' as const,
			gated: false,
			...over,
		})

		it('is on or off, not a level, when it runs inside the agent', () => {
			view = data({ integrations: [server()] })
			render(<AgentAccessSection agent={agent} />)
			const tools = screen.getByRole('list', { name: 'Tools' })
			expect(within(tools).getByText('Docs search')).toBeInTheDocument()
			expect(within(tools).queryByText('Off')).toBeNull()
			expect(screen.queryByRole('combobox', { name: 'Access to Docs search' })).toBeNull()
		})

		it('has the same levels as an integration when Maskin sits in front of it', async () => {
			view = data({ integrations: [server({ gated: true, access: 'read', source: 'grant' })] })
			render(<AgentAccessSection agent={agent} />)
			const select = screen.getByRole('combobox', { name: 'Access to Docs search' })
			expect(select).toHaveTextContent('Read')
			expect(screen.queryByRole('switch', { name: 'Docs search for this agent' })).toBeNull()
			await userEvent.setup().click(select)
			await userEvent.setup().click(await screen.findByRole('option', { name: 'Read & write' }))
			expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'read_write' })
		})

		it('turns on with its own grant when the default is off', async () => {
			view = data({ integrations: [server()] })
			render(<AgentAccessSection agent={agent} />)
			await userEvent
				.setup()
				.click(screen.getByRole('switch', { name: 'Docs search for this agent' }))
			expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'read_write' })
		})

		it('turns off with a No access grant when it is on for every agent', async () => {
			view = data({
				integrations: [server({ access: 'read', default_access: 'read', server_attached: true })],
			})
			render(<AgentAccessSection agent={agent} />)
			expect(screen.queryByText('On for all agents')).toBeNull()
			await userEvent
				.setup()
				.click(screen.getByRole('switch', { name: 'Docs search for this agent' }))
			expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'none' })
		})

		it('drops the grant when the choice matches the default', async () => {
			// An explicit On while the default is Off: switching it off is back to the default.
			view = data({
				integrations: [
					server({
						access: 'read_write',
						source: 'grant',
						default_access: 'none',
						server_attached: true,
					}),
				],
			})
			render(<AgentAccessSection agent={agent} />)
			await userEvent
				.setup()
				.click(screen.getByRole('switch', { name: 'Docs search for this agent' }))
			expect(removeGrant).toHaveBeenCalledWith('agent-1')
		})
	})
})
