import { McpServers } from '@/components/agents/mcp-servers'
import type { McpPresetResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockPresets = vi.fn()

vi.mock('@/hooks/use-integrations', () => ({
	useMcpPresets: () => ({ data: { presets: mockPresets() } }),
}))

function preset(overrides: Partial<McpPresetResponse> & { key: string }): McpPresetResponse {
	return {
		preset_id: overrides.key,
		provider: overrides.key,
		provider_label: overrides.key,
		label: overrides.key,
		integration_id: `int-${overrides.key}`,
		auto_injected: false,
		server: { type: 'http', url: `https://example.com/${overrides.key}` },
		...overrides,
	}
}

const slackPreset = preset({
	key: 'slack',
	label: 'Slack',
	server: {
		type: 'http',
		url: '${MASKIN_API_URL}/api/integrations/slack/mcp',
		headers: {
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
		},
	},
})

const sebastianPreset = preset({
	key: 'linkedin-sebastianbille-personal',
	provider: 'linkedin-unipile',
	label: 'Sebastian Bille',
	server: {
		type: 'http',
		url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp/linkedin-sebastianbille-personal',
		headers: {
			Authorization: 'Bearer ${MASKIN_API_KEY}',
			'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
		},
	},
})

const magnusPreset = preset({
	key: 'linkedin-magnus-noeddegaard-personal',
	provider: 'linkedin-unipile',
	label: 'Magnus Nødegaard',
})

const githubSindre = preset({
	key: 'github-sindre-ai',
	provider: 'github',
	label: 'GitHub sindre-ai',
	server: {
		type: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_SINDRE_AI}' },
	},
})

const githubVaerksted = preset({
	key: 'github-vaerksted-ai',
	provider: 'github',
	label: 'GitHub vaerksted-ai',
})

const stdioTools = {
	mcpServers: {
		github: {
			type: 'stdio',
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-github'],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok' },
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
		mockPresets.mockReturnValue([])
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

	it('shows "Add Maskin" button when maskin not present', () => {
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Add Maskin/ })).toBeInTheDocument()
	})

	it('hides "Add Maskin" button when maskin already present', () => {
		const tools = { mcpServers: { maskin: { type: 'http', url: 'http://example.com' } } }
		render(<McpServers tools={tools} onUpdate={vi.fn()} />)
		expect(screen.queryByRole('button', { name: /Add Maskin/ })).not.toBeInTheDocument()
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

	it('shows a quick-add button for each preset the API offers', () => {
		mockPresets.mockReturnValue([slackPreset])
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Add Slack/ })).toBeInTheDocument()
	})

	it('does not show quick-add for a preset whose key is already on the agent', () => {
		mockPresets.mockReturnValue([slackPreset])
		const slackTools = { mcpServers: { slack: { type: 'http', url: 'https://example.com' } } }
		render(<McpServers tools={slackTools} onUpdate={vi.fn()} />)
		expect(screen.queryByRole('button', { name: /Add Slack/ })).not.toBeInTheDocument()
	})

	it('shows no quick-add when the API offers nothing', () => {
		render(<McpServers tools={null} onUpdate={vi.fn()} />)
		expect(
			screen.queryByRole('button', { name: /^Add (?!Server|Maskin|Browser)/ }),
		).not.toBeInTheDocument()
	})

	it('renders one button per GitHub installation and writes only the clicked one', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		mockPresets.mockReturnValue([githubSindre, githubVaerksted])
		render(<McpServers tools={null} onUpdate={onUpdate} />)

		expect(screen.getAllByRole('button', { name: /Add GitHub/ })).toHaveLength(2)
		await user.click(screen.getByRole('button', { name: /Add GitHub sindre-ai/ }))

		expect(onUpdate).toHaveBeenCalledWith({
			mcpServers: {
				'github-sindre-ai': expect.objectContaining({
					env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_SINDRE_AI}' },
				}),
			},
		})
	})

	describe('LinkedIn per-identity Quick Add', () => {
		it('renders one button per connected identity, sorted alphabetically by label', () => {
			mockPresets.mockReturnValue([sebastianPreset, magnusPreset])
			render(<McpServers tools={null} onUpdate={vi.fn()} />)

			const magnusBtn = screen.getByRole('button', { name: /Add Magnus Nødegaard/ })
			const sebastianBtn = screen.getByRole('button', { name: /Add Sebastian Bille/ })
			// DOM order = alphabetical.
			expect(
				magnusBtn.compareDocumentPosition(sebastianBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
		})

		it('writes only the clicked identity to mcpServers, keyed on its instance slug', async () => {
			const user = userEvent.setup()
			const onUpdate = vi.fn()
			mockPresets.mockReturnValue([sebastianPreset, magnusPreset])
			render(<McpServers tools={null} onUpdate={onUpdate} />)

			await user.click(screen.getByRole('button', { name: /Add Sebastian Bille/ }))

			expect(onUpdate).toHaveBeenCalledWith({
				mcpServers: { [sebastianPreset.key]: sebastianPreset.server },
			})
		})

		it('hides an identity button once its instance slug is present in mcpServers', () => {
			mockPresets.mockReturnValue([sebastianPreset, magnusPreset])
			const tools = {
				mcpServers: {
					[sebastianPreset.key]: { type: 'http', url: 'https://example.com', headers: {} },
				},
			}
			render(<McpServers tools={tools} onUpdate={vi.fn()} />)

			expect(screen.queryByRole('button', { name: /Add Sebastian Bille/ })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Add Magnus Nødegaard/ })).toBeInTheDocument()
		})
	})

	it('calls onUpdate with maskin server when "Add Maskin" clicked', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		render(<McpServers tools={null} onUpdate={onUpdate} />)

		await user.click(screen.getByRole('button', { name: /Add Maskin/ }))

		expect(onUpdate).toHaveBeenCalledWith({
			mcpServers: expect.objectContaining({
				maskin: expect.objectContaining({ type: 'http' }),
			}),
		})
	})

	it('calls onUpdate with the preset server on quick-add click', async () => {
		const user = userEvent.setup()
		const onUpdate = vi.fn()
		mockPresets.mockReturnValue([slackPreset])
		render(<McpServers tools={null} onUpdate={onUpdate} />)

		await user.click(screen.getByRole('button', { name: /Add Slack/ }))

		expect(onUpdate).toHaveBeenCalledWith({
			mcpServers: expect.objectContaining({
				slack: expect.objectContaining({
					type: 'http',
					url: expect.stringContaining('/api/integrations/slack/mcp'),
				}),
			}),
		})
	})

	describe('delete flow', () => {
		it('shows confirm buttons when delete clicked', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)

			await user.click(screen.getByRole('button', { name: 'Delete server' }))
			expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
		})

		it('calls onUpdate without deleted server when confirmed', async () => {
			const user = userEvent.setup()
			const onUpdate = vi.fn()
			render(<McpServers tools={stdioTools} onUpdate={onUpdate} />)

			await user.click(screen.getByRole('button', { name: 'Delete server' }))
			await user.click(screen.getByRole('button', { name: 'Delete' }))
			expect(onUpdate).toHaveBeenCalledWith({ mcpServers: {} })
		})

		it('cancels delete and returns to normal state', async () => {
			const user = userEvent.setup()
			render(<McpServers tools={stdioTools} onUpdate={vi.fn()} />)

			await user.click(screen.getByRole('button', { name: 'Delete server' }))
			await user.click(screen.getByRole('button', { name: 'Cancel' }))
			expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
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
