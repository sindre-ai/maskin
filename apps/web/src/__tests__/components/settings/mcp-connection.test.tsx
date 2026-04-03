import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/auth', () => ({
	getApiKey: () => 'ank_test123',
}))

describe('McpConnectionSection', () => {
	it('renders MCP Connection label', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.getByText('MCP Connection')).toBeInTheDocument()
	})

	it('renders tabs for all client types', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.getByText('Claude.ai')).toBeInTheDocument()
		expect(screen.getByText('Claude Code')).toBeInTheDocument()
		expect(screen.getByText('Claude Desktop')).toBeInTheDocument()
		expect(screen.getByText('Custom')).toBeInTheDocument()
	})

	it('shows connector URL for claude-ai tab by default', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.getByText('Custom connector URL')).toBeInTheDocument()
		expect(screen.getByText(/\/mcp\?key=/)).toBeInTheDocument()
	})

	it('shows JSON config when switching to Claude Code tab', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)

		await user.click(screen.getByText('Claude Code'))
		expect(screen.getByText(/Or add to .mcp.json/)).toBeInTheDocument()
		expect(screen.getByText(/Quick setup/)).toBeInTheDocument()
	})

	it('shows required headers for custom tab', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)

		await user.click(screen.getByText('Custom'))
		expect(screen.getByText('Required Headers')).toBeInTheDocument()
		expect(screen.getByText(/X-Workspace-Id:/)).toBeInTheDocument()
	})
})
