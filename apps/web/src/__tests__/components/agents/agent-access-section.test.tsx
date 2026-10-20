import { AgentAccessSection, credentialStatus } from '@/components/agents/agent-access-section'
import type { ActorResponse, AgentAccessView } from '@/lib/api'
import { render, screen } from '@testing-library/react'
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
			},
		],
		credentials: [
			{
				integration_id: 'int-stripe',
				name: 'Stripe',
				kind: 'api_key',
				has_access: false,
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
	it('shows the level, whether tools are attached, and each saved credential', () => {
		render(<AgentAccessSection agent={agent} />)
		expect(screen.getByText('Linear')).toBeInTheDocument()
		expect(screen.getByText('Tools attached')).toBeInTheDocument()
		expect(screen.getByRole('combobox', { name: 'Access to Linear' })).toHaveTextContent(
			'Default (Read)',
		)
		expect(screen.getByText(/API key · No access/)).toBeInTheDocument()
	})

	it('reads an explicit grant by its level, and says when no tools are attached', () => {
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
				},
			],
		})
		render(<AgentAccessSection agent={agent} />)
		expect(screen.getByText('No tools attached')).toBeInTheDocument()
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

	it('says always, only in some chats, or no access for a saved credential', () => {
		expect(credentialStatus({ has_access: true, chat_count: 0 })).toBe('Always')
		expect(credentialStatus({ has_access: false, chat_count: 1 })).toBe('Only in 1 chat')
		expect(credentialStatus({ has_access: false, chat_count: 3 })).toBe('Only in 3 chats')
		expect(credentialStatus({ has_access: false, chat_count: 0 })).toBe('No access')
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

	it('renders nothing when there is nothing to show', () => {
		view = { integrations: [], credentials: [] }
		const { container } = render(<AgentAccessSection agent={agent} />)
		expect(container).toBeEmptyDOMElement()
	})
})
