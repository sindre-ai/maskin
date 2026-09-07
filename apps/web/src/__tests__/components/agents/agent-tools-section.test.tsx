import { AgentToolsSection } from '@/components/agents/agent-tools-section'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const updateMutate = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useUpdateActor: () => ({ mutate: updateMutate, isPending: false }),
}))

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: [] }),
}))

describe('AgentToolsSection', () => {
	beforeEach(() => {
		updateMutate.mockReset()
	})

	it('renders a labelled section with each tool from agent.tools — count, glyph, name and scope', () => {
		const agent = buildActorResponse({
			id: 'agent-tools',
			type: 'agent',
			tools: {
				mcpServers: {
					linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: {} },
					github: {
						type: 'stdio',
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-github'],
						env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' },
					},
				},
			},
		})

		render(<AgentToolsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByRole('region', { name: 'Tools' })).toBeInTheDocument()
		expect(screen.getByLabelText('2 tools attached')).toHaveTextContent('· 2')

		// Names.
		expect(screen.getByText('linear')).toBeInTheDocument()
		expect(screen.getByText('github')).toBeInTheDocument()

		// Scope — the HTTP tool's URL and the stdio tool's command line.
		expect(screen.getByText('https://mcp.linear.app/mcp')).toBeInTheDocument()
		expect(screen.getByText('npx -y @modelcontextprotocol/server-github')).toBeInTheDocument()

		// Glyphs are lucide SVGs rendered inside each row; each transport draws its
		// own. The Add Browser control carries a globe too, so scope the count to
		// the rows rather than the whole section.
		const region = screen.getByRole('region', { name: 'Tools' })
		expect(region.querySelectorAll('svg.lucide-terminal')).toHaveLength(1)
		expect(region.querySelectorAll('svg.lucide-globe').length).toBeGreaterThanOrEqual(1)
	})

	it('reads the empty state and shows zero count when the agent has no MCP servers', () => {
		const agent = buildActorResponse({ id: 'agent-tools-empty', type: 'agent', tools: null })
		render(<AgentToolsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByLabelText('0 tools attached')).toHaveTextContent('· 0')
		expect(
			screen.getByText(/No MCP servers configured\. Add servers to give this agent access/),
		).toBeInTheDocument()
	})

	// v2 removed the Manage toggle — the section is editable at rest, so the add
	// and per-row controls are reachable without a mode switch (mockup 2470–2488).
	it('is editable at rest and hands edits back through useUpdateActor', async () => {
		const agent = buildActorResponse({
			id: 'agent-tools-manage',
			type: 'agent',
			tools: {
				mcpServers: {
					github: {
						type: 'stdio',
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-github'],
						env: {},
					},
				},
			},
		})

		render(<AgentToolsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		// No mode switch to flip; the add controls are already on the page.
		expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Add Server/ })).toBeInTheDocument()

		// A two-step confirm delete lives inside ServerCard.
		await userEvent.click(screen.getByRole('button', { name: 'Delete server' }))
		await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

		expect(updateMutate).toHaveBeenCalledWith(
			{ id: 'agent-tools-manage', data: { tools: { mcpServers: {} } } },
			expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
		)
	})
})
