import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { trackEvent } from '@/lib/analytics'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let mockApiKey: string | null = 'ank_test123'

vi.mock('@/lib/auth', () => ({
	getApiKey: () => mockApiKey,
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn() },
}))

// The Claude tab reads the connector flag and the person's connections. Off and empty by default.
let mockFlagOn = false
let mockGrants: {
	data?: unknown[]
	isPending: boolean
	isError: boolean
	refetch: () => void
} = { data: [], isPending: false, isError: false, refetch: vi.fn() }
const mockDisconnect = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }

vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => mockFlagOn }))
vi.mock('@/hooks/use-oauth', () => ({
	useOauthGrants: () => mockGrants,
	useDisconnectGrant: () => mockDisconnect,
}))

const KEY = 'ank_test123'

function stubLocationAssign() {
	const assign = vi.fn()
	const original = window.location
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: { ...original, origin: 'https://app.example', assign },
	})
	return {
		assign,
		restore: () =>
			Object.defineProperty(window, 'location', { configurable: true, value: original }),
	}
}

describe('McpConnectionSection', () => {
	let location: ReturnType<typeof stubLocationAssign>

	beforeEach(() => {
		vi.clearAllMocks()
		mockApiKey = KEY
		mockFlagOn = false
		mockGrants = { data: [], isPending: false, isError: false, refetch: vi.fn() }
		location = stubLocationAssign()
	})

	afterEach(() => {
		location.restore()
	})

	it('renders one tab per app, in order, with no Claude tab', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
		expect(tabs).toEqual(['Claude Code', 'Cursor', 'VS Code', 'Claude Desktop', 'Other'])
		expect(screen.queryByRole('tab', { name: 'Claude' })).not.toBeInTheDocument()
	})

	it('opens on the Claude Code tab', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
			'aria-selected',
			'true',
		)
		expect(screen.getByText('Terminal')).toBeInTheDocument()
	})

	it('shows the MCP URL as the page origin plus /mcp', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(
			screen.getByText(/claude mcp add --transport http maskin https:\/\/app\.example\/mcp /),
		).toBeInTheDocument()

		await user.click(screen.getByRole('tab', { name: 'Other' }))
		expect(screen.getByText('https://app.example/mcp')).toBeInTheDocument()
	})

	it('puts the Authorization and workspace headers in the Claude Code command', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		const command = screen.getByText(/claude mcp add/).textContent
		expect(command).toContain(`--header "Authorization: Bearer ${KEY}"`)
		expect(command).toContain('--header "X-Workspace-Id: ws-1"')
	})

	it('shows the Headers block on the Other tab only', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)

		for (const name of ['Claude Code', 'Cursor', 'VS Code', 'Claude Desktop']) {
			await user.click(screen.getByRole('tab', { name }))
			expect(screen.queryByText('Headers')).not.toBeInTheDocument()
		}

		await user.click(screen.getByRole('tab', { name: 'Other' }))
		expect(screen.getByText('Headers')).toBeInTheDocument()
		expect(screen.getByText('Server URL')).toBeInTheDocument()
		expect(screen.getByText(/X-Workspace-Id: ws-1/)).toBeInTheDocument()
	})

	it('keeps the key out of the plain Server URL block', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: 'Other' }))
		expect(screen.getByText('https://app.example/mcp').textContent).not.toContain(KEY)
	})

	it('renders file-name block labels as written, not uppercased', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)

		await user.click(screen.getByRole('tab', { name: 'Cursor' }))
		expect(screen.getByText('~/.cursor/mcp.json').className).toContain('normal-case!')

		await user.click(screen.getByRole('tab', { name: 'Claude Desktop' }))
		expect(screen.getByText('claude_desktop_config.json').className).toContain('normal-case!')

		await user.click(screen.getByRole('tab', { name: 'Other' }))
		expect(screen.getByText('Server URL').className).not.toContain('normal-case!')
	})

	it('builds the Claude Desktop config around mcp-remote with both headers', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: 'Claude Desktop' }))

		const config = JSON.parse(screen.getByText(/mcp-remote/).textContent ?? '')
		expect(config.mcpServers.maskin).toEqual({
			command: 'npx',
			args: [
				'-y',
				'mcp-remote',
				'https://app.example/mcp',
				'--header',
				`Authorization: Bearer ${KEY}`,
				'--header',
				'X-Workspace-Id: ws-1',
			],
		})
	})

	it('builds the VS Code command with a JSON payload holding url and headers', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: 'VS Code' }))

		const text = screen.getByText(/^code --add-mcp /).textContent ?? ''
		const payload = JSON.parse(text.replace(/^code --add-mcp '/, '').replace(/'$/, ''))
		expect(payload).toEqual({
			name: 'maskin',
			type: 'http',
			url: 'https://app.example/mcp',
			headers: { Authorization: `Bearer ${KEY}`, 'X-Workspace-Id': 'ws-1' },
		})
	})

	describe('Add to Cursor / Add to VS Code', () => {
		it('renders a button with no link target, so no key sits in the page markup', async () => {
			const user = userEvent.setup()
			const { container } = render(<McpConnectionSection workspaceId="ws-1" />)

			for (const [tab, label] of [
				['Cursor', 'Add to Cursor'],
				['VS Code', 'Add to VS Code'],
			]) {
				await user.click(screen.getByRole('tab', { name: tab }))
				expect(screen.getByRole('button', { name: label })).toBeEnabled()
				expect(container.querySelector('a[href]')).toBeNull()
			}
		})

		it('opens the Cursor install link with the headers in its config payload', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)
			await user.click(screen.getByRole('tab', { name: 'Cursor' }))
			await user.click(screen.getByRole('button', { name: 'Add to Cursor' }))

			expect(location.assign).toHaveBeenCalledTimes(1)
			const link = new URL(location.assign.mock.calls[0][0])
			expect(link.protocol).toBe('cursor:')
			expect(link.host).toBe('anysphere.cursor-deeplink')
			expect(link.pathname).toBe('/mcp/install')
			expect(link.searchParams.get('name')).toBe('maskin')
			expect(JSON.parse(atob(link.searchParams.get('config') ?? ''))).toEqual({
				url: 'https://app.example/mcp',
				headers: { Authorization: `Bearer ${KEY}`, 'X-Workspace-Id': 'ws-1' },
			})
		})

		it('opens the VS Code install link with the headers in its config payload', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)
			await user.click(screen.getByRole('tab', { name: 'VS Code' }))
			await user.click(screen.getByRole('button', { name: 'Add to VS Code' }))

			const href: string = location.assign.mock.calls[0][0]
			expect(href.startsWith('vscode:mcp/install?')).toBe(true)
			expect(JSON.parse(decodeURIComponent(href.slice('vscode:mcp/install?'.length)))).toEqual({
				name: 'maskin',
				type: 'http',
				url: 'https://app.example/mcp',
				headers: { Authorization: `Bearer ${KEY}`, 'X-Workspace-Id': 'ws-1' },
			})
		})

		it('reports mcp_add_click with the tab name only', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)
			await user.click(screen.getByRole('tab', { name: 'Cursor' }))
			await user.click(screen.getByRole('button', { name: 'Add to Cursor' }))

			expect(trackEvent).toHaveBeenCalledTimes(1)
			expect(trackEvent).toHaveBeenCalledWith('mcp_add_click', { tab: 'cursor' })
		})
	})

	describe('Copy', () => {
		it('copies the block text and reports mcp_copy with the tab name only', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)
			await user.click(screen.getByRole('tab', { name: 'Other' }))

			const serverUrlBlock = screen.getByText('Server URL').closest('div')
				?.parentElement as HTMLElement
			await user.click(within(serverUrlBlock).getByRole('button', { name: 'Copy' }))

			expect(await navigator.clipboard.readText()).toBe('https://app.example/mcp')
			expect(trackEvent).toHaveBeenCalledWith('mcp_copy', { tab: 'other' })
			expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain(KEY)
			expect(within(serverUrlBlock).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
		})
	})

	describe('with no API key', () => {
		beforeEach(() => {
			mockApiKey = null
		})

		it('shows the sign out and back in notice on every tab', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)

			for (const tab of ['Claude Code', 'Cursor', 'VS Code', 'Claude Desktop', 'Other']) {
				await user.click(screen.getByRole('tab', { name: tab }))
				expect(screen.getByRole('alert')).toHaveTextContent(/Sign out and back in/)
			}
		})

		it('swaps the key for a placeholder and disables Copy on blocks that hold it', () => {
			render(<McpConnectionSection workspaceId="ws-1" />)
			expect(screen.getByText(/claude mcp add/).textContent).toContain('Bearer <API_KEY>')
			expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
		})

		it('disables Add to Cursor and Add to VS Code', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)

			await user.click(screen.getByRole('tab', { name: 'Cursor' }))
			expect(screen.getByRole('button', { name: 'Add to Cursor' })).toBeDisabled()

			await user.click(screen.getByRole('tab', { name: 'VS Code' }))
			expect(screen.getByRole('button', { name: 'Add to VS Code' })).toBeDisabled()
		})

		it('keeps the plain Server URL copyable on the Other tab', async () => {
			const user = userEvent.setup()
			render(<McpConnectionSection workspaceId="ws-1" />)
			await user.click(screen.getByRole('tab', { name: 'Other' }))

			const [serverUrlCopy, headersCopy] = screen.getAllByRole('button', { name: 'Copy' })
			expect(serverUrlCopy).toBeEnabled()
			expect(headersCopy).toBeDisabled()
		})
	})

	describe('Claude tab', () => {
		const GRANT = {
			id: 'g-1',
			client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
			client_name: 'Claude',
			workspace_id: 'ws-1',
			workspace_name: 'Acme Studio',
			created_at: '2026-11-03T10:00:00.000Z',
			last_used_at: null,
		}

		it('is not rendered without the flag and without a connection', () => {
			render(<McpConnectionSection workspaceId="ws-1" />)
			expect(screen.queryByRole('tab', { name: 'Claude', exact: true })).not.toBeInTheDocument()
			expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute(
				'aria-selected',
				'true',
			)
		})

		it('opens first with the flag on, tagged Sign in, with a prefill link that carries no key', () => {
			mockFlagOn = true
			render(<McpConnectionSection workspaceId="ws-1" />)

			const tab = screen.getByRole('tab', { name: /^Claude\s*Sign in$/i })
			expect(tab).toHaveAttribute('aria-selected', 'true')
			const link = screen.getByRole('link', { name: 'Add to Claude' })
			const href = new URL(link.getAttribute('href') ?? '')
			expect(`${href.origin}${href.pathname}`).toBe('https://claude.ai/customize/connectors')
			expect(href.searchParams.get('modal')).toBe('add-custom-connector')
			expect(href.searchParams.get('connectorName')).toBe('Maskin')
			expect(href.searchParams.get('connectorUrl')).toBe('https://app.example/mcp')
			expect(href.toString()).not.toContain(KEY)
		})

		it('puts the Add button first and keeps the manual steps closed until asked for', async () => {
			const user = userEvent.setup()
			mockFlagOn = true
			render(<McpConnectionSection workspaceId="ws-1" />)

			const add = screen.getByRole('link', { name: 'Add to Claude' })
			const steps = screen.getByText(
				'Click Add to Claude. The connector form opens with the name and URL filled in.',
			)
			expect(add.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

			const manual = screen.getByRole('button', { name: 'Or add it manually' })
			expect(manual).toHaveAttribute('aria-expanded', 'false')
			expect(screen.queryByText('Server URL')).not.toBeInTheDocument()
			await user.click(manual)
			expect(manual).toHaveAttribute('aria-expanded', 'true')
			expect(screen.getByText('https://app.example/mcp')).toBeInTheDocument()
		})

		it('shows the connection and hides Add when connected, even with the flag off', () => {
			mockGrants = { data: [GRANT], isPending: false, isError: false, refetch: vi.fn() }
			render(<McpConnectionSection workspaceId="ws-1" />)

			expect(screen.getByRole('tab', { name: /^Claude\s*Connected$/i })).toHaveAttribute(
				'aria-selected',
				'true',
			)
			expect(screen.getByText('Workspace: Acme Studio')).toBeInTheDocument()
			expect(screen.queryByRole('link', { name: 'Add to Claude' })).not.toBeInTheDocument()
			expect(
				screen.getByText(/Adding new Claude connections is switched off for now/),
			).toBeInTheDocument()
			expect(screen.queryByText(/One row per workspace/)).not.toBeInTheDocument()
		})

		it('lists newest first and explains the one-row-per-workspace rule for two connections', () => {
			mockFlagOn = true
			mockGrants = {
				data: [
					GRANT,
					{
						...GRANT,
						id: 'g-2',
						workspace_name: 'Personal',
						created_at: '2026-11-04T10:00:00.000Z',
					},
				],
				isPending: false,
				isError: false,
				refetch: vi.fn(),
			}
			render(<McpConnectionSection workspaceId="ws-1" />)

			const rows = screen.getAllByText(/^Workspace: /).map((row) => row.textContent)
			expect(rows).toEqual(['Workspace: Personal', 'Workspace: Acme Studio'])
			expect(screen.getByText(/One row per workspace/)).toBeInTheDocument()
			expect(screen.queryByText(/switched off for now/)).not.toBeInTheDocument()
		})

		it('disconnects the chosen row after the dialog is confirmed', async () => {
			const user = userEvent.setup()
			mockGrants = { data: [GRANT], isPending: false, isError: false, refetch: vi.fn() }
			render(<McpConnectionSection workspaceId="ws-1" />)

			await user.click(screen.getByRole('button', { name: 'Disconnect' }))
			expect(screen.getByRole('heading', { name: 'Disconnect Claude?' })).toBeInTheDocument()
			expect(screen.getByText(/Claude may then show "connection expired"/)).toBeInTheDocument()
			expect(mockDisconnect.mutate).not.toHaveBeenCalled()

			await user.click(
				within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
			)
			expect(mockDisconnect.mutate).toHaveBeenCalledWith('g-1', expect.any(Object))
		})

		it('keeps the Add steps when the check fails, with a Try again', async () => {
			const user = userEvent.setup()
			const refetch = vi.fn()
			mockFlagOn = true
			mockGrants = { data: undefined, isPending: false, isError: true, refetch }
			render(<McpConnectionSection workspaceId="ws-1" />)

			expect(screen.getByText("We couldn't check whether Claude is connected.")).toBeInTheDocument()
			expect(screen.getByRole('link', { name: 'Add to Claude' })).toBeInTheDocument()
			await user.click(screen.getByRole('button', { name: 'Try again' }))
			expect(refetch).toHaveBeenCalled()
		})
	})
})
