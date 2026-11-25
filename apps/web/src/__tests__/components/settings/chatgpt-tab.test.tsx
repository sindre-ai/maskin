import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { MCP_OAUTH_CHATGPT_CLIENT_ID, MCP_OAUTH_CLAUDE_CLIENT_ID } from '@maskin/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/auth', () => ({ getApiKey: () => 'ank_test123' }))
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const flag = { on: true }
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))

let mockGrants: {
	data?: unknown[]
	isPending: boolean
	isError: boolean
	refetch: () => void
} = { data: [], isPending: false, isError: false, refetch: vi.fn() }
const mockDisconnect = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }
const useDisconnectGrant = vi.fn((_appName?: string) => mockDisconnect)

vi.mock('@/hooks/use-oauth', () => ({
	useOauthGrants: () => mockGrants,
	useDisconnectGrant: (appName?: string) => useDisconnectGrant(appName),
}))

const BASE = {
	workspace_id: '6f0d1f0e-0000-4000-8000-000000000001',
	created_at: '2026-11-05T10:00:00.000Z',
	last_used_at: null,
}
const CLAUDE = {
	...BASE,
	id: 'g-claude',
	client_id: MCP_OAUTH_CLAUDE_CLIENT_ID,
	client_name: 'Claude',
	workspace_name: 'Claude Workspace',
}
const CHATGPT = {
	...BASE,
	id: 'g-chatgpt',
	client_id: MCP_OAUTH_CHATGPT_CLIENT_ID,
	client_name: 'ChatGPT',
	workspace_name: 'ChatGPT Workspace',
}

function setGrants(data: unknown[]) {
	mockGrants = { data, isPending: false, isError: false, refetch: vi.fn() }
}

describe('ChatGPT tab in Settings, MCP', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		flag.on = true
		setGrants([])
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: { ...window.location, origin: 'https://app.example' },
		})
	})

	it('adds no tab with the flag off, and the Claude tab still lists every connection', () => {
		flag.on = false
		setGrants([CHATGPT])
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.queryByRole('tab', { name: /ChatGPT/ })).not.toBeInTheDocument()
		expect(screen.getByText('Workspace: ChatGPT Workspace')).toBeInTheDocument()
	})

	it('puts the ChatGPT tab right after Claude with the flag on', () => {
		render(<McpConnectionSection workspaceId="ws-1" />)
		const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
		expect(tabs.slice(0, 3)).toEqual(['ClaudeSign in', 'ChatGPTSign in', 'Claude Code'])
	})

	it('shows the steps and the server URL before a connection exists', async () => {
		const user = userEvent.setup()
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: /ChatGPT/ }))
		expect(screen.getByText(/open Plugins, click the plus button/)).toBeInTheDocument()
		expect(screen.getByText(/Create as a plugin/)).toBeInTheDocument()
		expect(screen.getByText('https://app.example/mcp')).toBeInTheDocument()
		expect(screen.getByText(/No key to paste/)).toBeInTheDocument()
	})

	it('reads Connected on the ChatGPT tab only, and splits the grants between the two tabs', async () => {
		const user = userEvent.setup()
		setGrants([CLAUDE, CHATGPT])
		render(<McpConnectionSection workspaceId="ws-1" />)

		expect(screen.getByRole('tab', { name: /^Claude\s*Connected$/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /^ChatGPT\s*Connected$/ })).toBeInTheDocument()
		expect(screen.getByText('Workspace: Claude Workspace')).toBeInTheDocument()
		expect(screen.queryByText('Workspace: ChatGPT Workspace')).not.toBeInTheDocument()

		await user.click(screen.getByRole('tab', { name: /ChatGPT/ }))
		expect(screen.getByText('Workspace: ChatGPT Workspace')).toBeInTheDocument()
		expect(screen.queryByText('Workspace: Claude Workspace')).not.toBeInTheDocument()
	})

	it('keeps Claude on Sign in when only ChatGPT is connected', () => {
		setGrants([CHATGPT])
		render(<McpConnectionSection workspaceId="ws-1" />)
		expect(screen.getByRole('tab', { name: /^Claude\s*Sign in$/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /^ChatGPT\s*Connected$/ })).toBeInTheDocument()
	})

	it('disconnects a ChatGPT connection by its id and names ChatGPT in the dialog', async () => {
		const user = userEvent.setup()
		setGrants([CHATGPT])
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: /ChatGPT/ }))
		await user.click(screen.getByRole('button', { name: 'Disconnect' }))
		expect(screen.getByRole('heading', { name: 'Disconnect ChatGPT?' })).toBeInTheDocument()
		expect(useDisconnectGrant).toHaveBeenCalledWith('ChatGPT')
		const [confirm] = screen.getAllByRole('button', { name: 'Disconnect' }).slice(-1)
		await user.click(confirm as HTMLElement)
		expect(mockDisconnect.mutate).toHaveBeenCalledWith('g-chatgpt', expect.any(Object))
	})

	it('keeps the steps when the check fails, with a Try again', async () => {
		const user = userEvent.setup()
		const refetch = vi.fn()
		mockGrants = { data: undefined, isPending: false, isError: true, refetch }
		render(<McpConnectionSection workspaceId="ws-1" />)
		await user.click(screen.getByRole('tab', { name: /ChatGPT/ }))
		expect(screen.getByText("We couldn't check whether ChatGPT is connected.")).toBeInTheDocument()
		expect(screen.getByText(/Add custom MCP server/)).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Try again' }))
		expect(refetch).toHaveBeenCalled()
	})
})
