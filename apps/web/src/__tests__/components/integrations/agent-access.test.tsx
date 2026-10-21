import {
	ACCESS_ORDER,
	AgentAccess,
	DEFAULT_ACCESS_ORDER,
	startingAccess,
	summarizeAgentAccess,
} from '@/components/integrations/agent-access'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationResponse } from '../../factories'

const AGENTS = [
	{ id: 'agent-1', name: 'Infra & DevOps', type: 'agent' },
	{ id: 'agent-2', name: 'Code Reviewer', type: 'agent' },
	{ id: 'agent-3', name: 'Writer', type: 'agent' },
	{ id: 'human-1', name: 'Magnus', type: 'human' },
]

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: AGENTS }) }))

const setGrant = vi.fn()
const removeGrant = vi.fn()
const setDefault = vi.fn()
vi.mock('@/hooks/use-integrations', () => ({
	useSetAgentGrant: () => ({ mutate: setGrant, isPending: false }),
	useRemoveAgentGrant: () => ({ mutate: removeGrant, isPending: false }),
	useSetDefaultAgentAccess: () => ({ mutate: setDefault, isPending: false }),
}))

const mockRole = vi.fn(() => 'member')
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { role: mockRole() }, workspaceId: 'ws-1' }),
}))

const mockActor = vi.fn<() => { id: string; type: string } | null>(() => ({
	id: 'human-1',
	type: 'human',
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => mockActor() }))

beforeEach(() => {
	vi.clearAllMocks()
	mockRole.mockReturnValue('member')
	mockActor.mockReturnValue({ id: 'human-1', type: 'human' })
})

function renderOpen(over: Parameters<typeof buildIntegrationResponse>[0] = {}) {
	const integration = buildIntegrationResponse({
		id: 'int-1',
		createdBy: 'human-1',
		defaultAgentAccess: 'read',
		agentGrants: [],
		...over,
	})
	const user = userEvent.setup()
	render(<AgentAccess integration={integration} workspaceId="ws-1" />)
	return { user, open: () => user.click(screen.getByRole('button', { name: /Agent access/ })) }
}

describe('summarizeAgentAccess', () => {
	it('says all agents can read when nobody has an override', () => {
		expect(summarizeAgentAccess('read', [])).toBe('All agents can read')
	})

	it('counts the agents that can also write', () => {
		expect(summarizeAgentAccess('read', [{ access: 'read_write' }])).toBe(
			'All agents can read · 1 can also write',
		)
		expect(summarizeAgentAccess('read', [{ access: 'read_write' }, { access: 'read_write' }])).toBe(
			'All agents can read · 2 can also write',
		)
	})

	it('does not count a read-only override as a writer', () => {
		expect(summarizeAgentAccess('read', [{ access: 'read' }])).toBe('All agents can read')
	})

	it('describes a restricted integration by how many agents have access', () => {
		expect(summarizeAgentAccess('none', [])).toBe('No agents have access')
		expect(summarizeAgentAccess('none', [{ access: 'read' }])).toBe('1 agent has access')
		expect(summarizeAgentAccess('none', [{ access: 'read' }, { access: 'read_write' }])).toBe(
			'2 agents have access',
		)
	})

	it('says how many agents were taken off an integration the rest can read', () => {
		expect(summarizeAgentAccess('read', [{ access: 'none' }])).toBe(
			'All agents can read · 1 has no access',
		)
		expect(
			summarizeAgentAccess('read', [
				{ access: 'none' },
				{ access: 'none' },
				{ access: 'read_write' },
			]),
		).toBe('All agents can read · 1 can also write · 2 have no access')
	})

	it('does not count a No access entry as having access when the default is none', () => {
		expect(summarizeAgentAccess('none', [{ access: 'none' }])).toBe('No agents have access')
	})

	it('says all agents can read & write, and counts the ones held back', () => {
		expect(summarizeAgentAccess('read_write', [])).toBe('All agents can read & write')
		expect(summarizeAgentAccess('read_write', [{ access: 'read_write' }])).toBe(
			'All agents can read & write',
		)
		expect(
			summarizeAgentAccess('read_write', [
				{ access: 'read' },
				{ access: 'none' },
				{ access: 'none' },
			]),
		).toBe('All agents can read & write · 1 can only read · 2 have no access')
	})
})

describe('startingAccess', () => {
	it('starts a new agent one step above the default', () => {
		expect(startingAccess('read')).toBe('read_write')
		expect(startingAccess('none')).toBe('read')
		// Everyone already writes: an entry of its own can only hold the agent back.
		expect(startingAccess('read_write')).toBe('read')
	})
})

describe('access levels offered', () => {
	it('offers the same three levels for every integration, Gmail included', () => {
		expect(ACCESS_ORDER).toEqual(['read', 'read_write', 'none'])
		expect(DEFAULT_ACCESS_ORDER).toEqual(['read', 'read_write', 'none'])
	})
})

describe('AgentAccess', () => {
	it('is collapsed to one summary line until opened', async () => {
		const { open } = renderOpen({
			agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		})
		expect(screen.getByText('All agents can read · 1 can also write')).toBeInTheDocument()
		expect(screen.queryByText('All other agents')).not.toBeInTheDocument()
		await open()
		expect(screen.getByText('All other agents')).toBeInTheDocument()
		expect(screen.getByText('Infra & DevOps')).toBeInTheDocument()
	})

	it('lists only agents with an override, never people or the rest', async () => {
		const { open } = renderOpen({
			agentGrants: [
				{ actorId: 'agent-1', access: 'read_write' },
				{ actorId: 'human-1', access: 'read' },
			],
		})
		await open()
		expect(screen.getByText('Infra & DevOps')).toBeInTheDocument()
		expect(screen.queryByText('Code Reviewer')).not.toBeInTheDocument()
		expect(screen.queryByText('Magnus')).not.toBeInTheDocument()
	})

	it('has no remove button: an agent set to what everyone else gets drops out of the list', async () => {
		const { open, user } = renderOpen({
			agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		})
		await open()
		expect(screen.queryByRole('button', { name: 'Remove Infra & DevOps' })).not.toBeInTheDocument()
		await user.click(screen.getByRole('combobox', { name: 'Access for Infra & DevOps' }))
		await user.click(await screen.findByRole('option', { name: 'Read' }))
		expect(removeGrant).toHaveBeenCalledWith('agent-1')
		expect(setGrant).not.toHaveBeenCalled()
	})

	it('changes an override and the default', async () => {
		const { open, user } = renderOpen({
			agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		})
		await open()
		await user.click(screen.getByRole('combobox', { name: 'Access for Infra & DevOps' }))
		await user.click(await screen.findByRole('option', { name: 'No access' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-1', access: 'none' })

		await user.click(screen.getByRole('combobox', { name: 'Access for all other agents' }))
		await user.click(await screen.findByRole('option', { name: 'No access' }))
		expect(setDefault).toHaveBeenCalledWith('none')
	})

	it('lets the default for all other agents be Read & write', async () => {
		const { open, user } = renderOpen()
		await open()
		await user.click(screen.getByRole('combobox', { name: 'Access for all other agents' }))
		await user.click(await screen.findByRole('option', { name: 'Read & write' }))
		expect(setDefault).toHaveBeenCalledWith('read_write')
	})

	it('offers Read & write as the default for Gmail too, and says each email still needs approval', async () => {
		const { open, user } = renderOpen({ provider: 'gmail' })
		await open()
		expect(screen.getByText(/Each email still waits for your approval/)).toBeInTheDocument()
		await user.click(screen.getByRole('combobox', { name: 'Access for all other agents' }))
		await user.click(await screen.findByRole('option', { name: 'Read & write' }))
		expect(setDefault).toHaveBeenCalledWith('read_write')
	})

	it('adds an agent that has no override, starting at read & write when the default is read', async () => {
		const { open, user } = renderOpen({
			agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		})
		await open()
		await user.click(screen.getByRole('combobox', { name: 'Add an agent' }))
		// The agent that already has an entry is not offered again.
		expect(screen.queryByRole('option', { name: 'Infra & DevOps' })).not.toBeInTheDocument()
		await user.click(await screen.findByRole('option', { name: 'Code Reviewer' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-2', access: 'read_write' })
	})

	it('adds an agent at read when the default is no access', async () => {
		const { open, user } = renderOpen({ defaultAgentAccess: 'none' })
		await open()
		await user.click(screen.getByRole('combobox', { name: 'Add an agent' }))
		await user.click(await screen.findByRole('option', { name: 'Writer' }))
		expect(setGrant).toHaveBeenCalledWith({ actorId: 'agent-3', access: 'read' })
	})

	it('is read-only for a member who did not connect it', async () => {
		const { open } = renderOpen({
			createdBy: 'someone-else',
			agentGrants: [{ actorId: 'agent-1', access: 'read_write' }],
		})
		await open()
		expect(screen.getByRole('combobox', { name: 'Access for all other agents' })).toBeDisabled()
		expect(screen.getByRole('combobox', { name: 'Access for Infra & DevOps' })).toBeDisabled()
		expect(screen.queryByRole('combobox', { name: 'Add an agent' })).not.toBeInTheDocument()
		expect(screen.getByText(/Only the person who connected this/)).toBeInTheDocument()
	})

	it('lets a workspace admin edit an integration someone else connected', async () => {
		mockRole.mockReturnValue('admin')
		const { open } = renderOpen({ createdBy: 'someone-else' })
		await open()
		expect(screen.getByRole('combobox', { name: 'Access for all other agents' })).toBeEnabled()
	})

	it('does not let an agent edit', async () => {
		mockActor.mockReturnValue({ id: 'agent-1', type: 'agent' })
		const { open } = renderOpen({ createdBy: 'agent-1' })
		await open()
		expect(screen.getByRole('combobox', { name: 'Access for all other agents' })).toBeDisabled()
	})
})
