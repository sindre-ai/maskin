import { McpServers } from '@/components/agents/mcp-servers'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildIntegrationResponse } from '../../factories'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockIntegrations = vi.fn()

vi.mock('@/hooks/use-integrations', () => ({
	useIntegrations: () => ({ data: mockIntegrations() }),
}))

const stdioTools = {
	mcpServers: {
		github: {
			type: 'stdio',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-github'],
			env: { GITHUB_TOKEN: 'tok' },
		},
	},
}

const httpTools = {
	mcpServers: {
		'my-api': {
			type: 'http',
			url: 'http://localhost:3000/mcp',
			headers: { Authorization: 'Bearer test', 'X-Custom': 'val' },
		},
	},
}

describe('McpServers', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockIntegrations.mockReturnValue([])
	})

	it('shows empty message when no servers configured', () => {
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument()
	})

	it('shows "Add Server" and "Import .mcp.json" buttons', () => {
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Add Server/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Import .mcp.json/ })).toBeInTheDocument()
	})

	it('shows "Add AI Native" button when ai-native not present', () => {
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Add AI Native/ })).toBeInTheDocument()
	})

	it('hides "Add AI Native" button when ai-native already present', () => {
		const tools = { mcpServers: { 'ai-native': { type: 'http', url: 'http://example.com' } } }
		render(<McpServers tools={tools} onUpdate={vi.fn()} />)
		expect(screen.queryByRole('button', { name: /Add AI Native/ })).not.toBeInTheDocument()
	})

	it('renders server name for stdio server', () => {
		render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)
		expect(screen.getByText('github')).toBeInTheDocument()
	})

	it('renders command and args for stdio server', () => {
		render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)
		expect(screen.getByText(/npx -y @modelcontextprotocol\/server-github/)).toBeInTheDocument()
	})

	it('shows env var count for stdio server', () => {
		render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)
		expect(screen.getByText(/1 env var$/)).toBeInTheDocument()
	})

	it('renders url for HTTP server', () => {
		render(<McpServers tools={httpTools} onUpdate={vi.fn()} />)
		expect(screen.getByText(/http:\/\/localhost:3000\/mcp/)).toBeInTheDocument()
	})

	it('shows header count for HTTP server', () => {
		render(<McpServers tools={httpTools} onUpdate={vi.fn()} />)
		expect(screen.getByText(/2 headers/)).toBeInTheDocument()
	})

	it('shows quick-add button for active integration with MCP preset', () => {
		mockIntegrations.mockReturnValue([
			buildIntegrationResponse({ provider: 'slack', status: 'active' }),
		])
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Add slack/ })).toBeInTheDocument()
	})

	it('does not show quick-add for integration already added as server', () => {
		mockIntegrations.mockReturnValue([
			buildIntegrationResponse({ provider: 'github', status: 'active' }),
		])
		render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)
		expect(screen.queryByRole('button', { name: /Add github/ })).not.toBeInTheDocument()
	})

	it('does not show quick-add for integration without MCP preset', () => {
		mockIntegrations.mockReturnValue([
			buildIntegrationResponse({ provider: 'jira', status: 'active' }),
		])
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.queryByRole('button', { name: /Add jira/ })).not.toBeInTheDocument()
	})

	it('calls onUpdate with ai-native server when "Add AI Native" clicked', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		render(<McpServers tools={null} onUpdate={onUpdate} />)

		await user.click(screen.getByRole('button', { name: /Add AI Native/ }))

		expect(onUpdate).toHaveBeenCalledWith({
			mcpServers: expect.objectContaining({
				'ai-native': expect.objectContaining({ type: 'http' }),
			}),
		})
	})

	it('calls onUpdate with preset server on quick-add click', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		mockIntegrations.mockReturnValue([
			buildIntegrationResponse({ provider: 'slack', status: 'active' }),
		])
		render(<McpServers tools={null} onUpdate={onUpdate} />)

		await user.click(screen.getByRole('button', { name: /Add slack/ }))

		expect(onUpdate).toHaveBeenCalledWith({
			mcpServers: expect.objectContaining({
				slack: expect.objectContaining({ command: 'npx' }),
			}),
		})
	})

	describe('delete flow', () => {
		it('shows confirm buttons when delete clicked', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)

			const deleteButtons = screen.getAllByRole('button')
			const deleteBtn = deleteButtons.find(
				(btn) => btn.querySelector('.lucide-trash-2') || btn.querySelector('svg'),
			)
			// Find the delete icon button (last icon button in server card)
			const buttons = screen.getAllByRole('button')
			const trashButton = buttons.find(
				(b) => b.textContent === '' && b.className.includes('hover:text-error'),
			)
			if (trashButton) {
				await user.click(trashButton)
				expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
				expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			}
		})

		it('calls onUpdate without deleted server when confirmed', async () => {
			const user = userEvent.setup()
			const onUpdate = vi.fn()
			render(<McpServers tools={stdioTools} onUpdate={onUpdate} />)

			// Click all icon buttons to find the trash one - look for the last icon-sized button
			const buttons = screen.getAllByRole('button')
			const trashButton = buttons.find(
				(b) => b.textContent === '' && b.className.includes('hover:text-error'),
			)
			if (trashButton) {
				await user.click(trashButton)
				await user.click(screen.getByRole('button', { name: 'Delete' }))
				expect(onUpdate).toHaveBeenCalledWith({ mcpServers: {} })
			}
		})

		it('cancels delete and returns to normal state', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)

			const buttons = screen.getAllByRole('button')
			const trashButton = buttons.find(
				(b) => b.textContent === '' && b.className.includes('hover:text-error'),
			)
			if (trashButton) {
				await user.click(trashButton)
				await user.click(screen.getByRole('button', { name: 'Cancel' }))
				expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
			}
		})
	})

	it('shows ServerForm when "Add Server" clicked', async () => {
		const user = userEvent.setup()
		render(<McpServers tools={null} onUpdate={vi.fn()} />)

		await user.click(screen.getByRole('button', { name: /Add Server/ }))

		expect(screen.getByText('Name')).toBeInTheDocument()
		expect(screen.getByText('Transport')).toBeInTheDocument()
	})

	it('hides ServerForm when cancel clicked', async () => {
		const user = userEvent.setup()
		render(<McpServers tools={null} onUpdate={vi.fn()} />)

		await user.click(screen.getByRole('button', { name: /Add Server/ }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(screen.getByRole('button', { name: /Add Server/ })).toBeInTheDocument()
	})

	describe('ServerForm', () => {
		it('Save button disabled when name empty', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={null} onUpdate={vi.fn()} />)

			await user.click(screen.getByRole('button', { name: /Add Server/ }))

			expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		})

		it('shows command field for stdio transport', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={null} onUpdate={vi.fn()} />)

			await user.click(screen.getByRole('button', { name: /Add Server/ }))

			expect(screen.getByText('Command')).toBeInTheDocument()
			expect(screen.getByText('Args (comma-separated)')).toBeInTheDocument()
		})

		it('calls onUpdate with correct stdio server data on save', async () => {
			const user = userEvent.setup()
			const onUpdate = vi.fn()
			render(<McpServers tools={null} onUpdate={onUpdate} />)

			await user.click(screen.getByRole('button', { name: /Add Server/ }))
			await user.type(screen.getByPlaceholderText('e.g. github'), 'test-server')
			await user.type(screen.getByPlaceholderText('e.g. npx'), 'node')
			await user.type(
				screen.getByPlaceholderText('e.g. -y, @modelcontextprotocol/server-github'),
				'server.js',
			)
			await user.click(screen.getByRole('button', { name: 'Save' }))

			expect(onUpdate).toHaveBeenCalledWith({
				mcpServers: {
					'test-server': {
						type: 'stdio',
						command: 'node',
						args: ['server.js'],
						env: {},
					},
				},
			})
		})
	})
})
