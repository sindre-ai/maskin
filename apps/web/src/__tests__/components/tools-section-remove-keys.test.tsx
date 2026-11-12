import { ToolsSection } from '@/components/integrations/tools-section'
import type { IntegrationResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../setup'

const server = {
	id: 'int-1',
	provider: 'custom-mcp',
	status: 'active',
	displayName: 'Docs server',
	createdBy: 'actor-1',
	config: { custom_mcp: { transport: 'http', target: 'https://example.com/mcp' } },
} as unknown as IntegrationResponse

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: [server] }),
	useCreateCustomMcpServer: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
	useUpdateCustomMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
	useCustomMcpServer: () => ({ data: undefined, isLoading: true }),
	useRemoveCustomMcpServer: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', type: 'human', name: 'Owner' }),
}))

vi.mock('@/components/integrations/tool-server-access', () => ({
	ToolServerAccess: () => null,
}))

const renderSection = () =>
	render(<ToolsSection workspaceId="ws-1" />, {
		wrapper: createWorkspaceWrapper({ role: 'owner' }),
	})

describe('removing a custom MCP server from the keyboard', () => {
	it('puts focus on Cancel when the bin button is pressed', async () => {
		renderSection()
		await userEvent.click(screen.getByRole('button', { name: 'Remove Docs server' }))
		expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
	})

	it('cancels on Esc and puts focus back on the bin button', async () => {
		renderSection()
		await userEvent.click(screen.getByRole('button', { name: 'Remove Docs server' }))
		await userEvent.keyboard('{Escape}')
		expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
		expect(screen.getByRole('button', { name: 'Remove Docs server' })).toHaveFocus()
	})

	it('puts focus back on the bin button when Cancel is pressed', async () => {
		renderSection()
		await userEvent.click(screen.getByRole('button', { name: 'Remove Docs server' }))
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(screen.getByRole('button', { name: 'Remove Docs server' })).toHaveFocus()
	})
})
