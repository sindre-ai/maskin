import { extensionRowStatus } from '@/components/extensions/custom-extensions-section'
import { McpDialog } from '@/components/extensions/mcp-dialog'
import { buildMcpConfig } from '@/components/extensions/mcp-form'
import { McpSection } from '@/components/extensions/mcp-section'
import { SetupProgressCard } from '@/components/extensions/setup-progress-card'
import type { ExtensionResponse } from '@/lib/api'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), update: vi.fn() }))

vi.mock('@/hooks/use-extensions', () => ({
	useProbeMcp: () => ({ mutateAsync: mocks.probe, isPending: false }),
	useUpdateExtension: () => ({ mutateAsync: mocks.update, isPending: false }),
}))

const mcpConfig = buildMcpConfig({
	slug: 'fireflies',
	serverUrl: 'https://api.fireflies.ai/mcp',
	auth: 'api-key',
	tools: [
		{ name: 'get_transcript', kind: 'read' },
		{ name: 'bookmark_meeting', kind: 'write' },
	],
})

function buildExtension(overrides: Partial<ExtensionResponse> = {}): ExtensionResponse {
	return {
		id: 'ext-1',
		workspaceId: 'ws-1',
		slug: 'fireflies',
		name: 'Fireflies',
		status: 'draft',
		mcpConfig: null,
		webhookConfig: null,
		webhookToken: null,
		webhookUrl: null,
		hasSigningSecret: false,
		hasMcpKey: false,
		toolGrants: {},
		mcpLastError: null,
		createdBy: null,
		createdAt: '2026-10-19T10:00:00.000Z',
		updatedAt: '2026-10-19T10:00:00.000Z',
		lastDeliveryAt: null,
		committedDeliveries: 0,
		...overrides,
	}
}

function wiredExtension(overrides: Partial<ExtensionResponse> = {}) {
	return buildExtension({ status: 'active', mcpConfig, hasMcpKey: true, ...overrides })
}

const probeTools = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		name: `get_item_${String(i).padStart(2, '0')}`,
		kind: 'read' as const,
	}))

describe('McpDialog', () => {
	beforeEach(() => {
		mocks.probe.mockReset()
		mocks.update.mockReset().mockResolvedValue(undefined)
	})

	const renderAdd = (onOpenChange = vi.fn()) =>
		render(<McpDialog ext={buildExtension()} workspaceId="ws-1" open onOpenChange={onOpenChange} />)

	function fillAndVerify(url = 'https://api.fireflies.ai/mcp', key = 'sk-123') {
		fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: url } })
		fireEvent.change(screen.getByLabelText('API key'), { target: { value: key } })
		fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }))
	}

	it('offers API key and None, with OAuth 2.1 shown but disabled', () => {
		renderAdd()
		expect(screen.getByRole('radio', { name: /API key/ })).toBeEnabled()
		expect(screen.getByRole('radio', { name: /None/ })).toBeEnabled()
		expect(screen.getByRole('radio', { name: /OAuth 2.1/ })).toBeDisabled()
		expect(screen.getByText('soon')).toBeInTheDocument()
		expect(screen.getByText(/HTTP transport are not supported yet/)).toBeInTheDocument()
	})

	it('keeps Verify & save disabled until a URL is typed, and asks for the key', () => {
		renderAdd()
		expect(screen.getByRole('button', { name: 'Verify & save' })).toBeDisabled()
		fireEvent.change(screen.getByLabelText('Server URL'), {
			target: { value: 'https://x.example/mcp' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Verify & save' }))
		expect(screen.getByText('Paste the vendor API key.')).toBeInTheDocument()
		expect(mocks.probe).not.toHaveBeenCalled()
	})

	it('shows the error band and saves nothing when the probe fails', async () => {
		mocks.probe.mockResolvedValue({
			ok: false,
			reason: 'rejected',
			message: 'The server rejected the API key.',
		})
		renderAdd()
		fillAndVerify()
		expect(await screen.findByText("Couldn't verify Fireflies MCP")).toBeInTheDocument()
		expect(
			screen.getByText(/The server rejected the API key. Nothing was saved./),
		).toBeInTheDocument()
		expect(mocks.update).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it('lets the owner declare tools by hand after a failed probe, then saves them', async () => {
		mocks.probe.mockResolvedValue({
			ok: false,
			reason: 'unreachable',
			message: "Couldn't reach the server.",
		})
		renderAdd()
		fillAndVerify()
		fireEvent.click(await screen.findByRole('button', { name: 'Declare tools by hand' }))
		fireEvent.change(screen.getByLabelText('Tool names'), {
			target: { value: 'get_transcript\nbookmark_meeting' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect(screen.getByText(/not verified against the server/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
		const sent = mocks.update.mock.calls[0]?.[0]
		expect(sent.mcp_api_key).toBe('sk-123')
		expect(sent.status).toBe('active')
		expect(sent.mcp_config.tools).toEqual([
			{ name: 'get_transcript', kind: 'read' },
			{ name: 'bookmark_meeting', kind: 'write' },
		])
	})

	it('shows the tools with a counter and saves the ticked ones with the key', async () => {
		mocks.probe.mockResolvedValue({ ok: true, tools: probeTools(3) })
		renderAdd()
		fillAndVerify()
		expect(await screen.findByText('Selected: 3/20')).toBeInTheDocument()
		expect(mocks.probe).toHaveBeenCalledWith({
			server_url: 'https://api.fireflies.ai/mcp',
			api_key: 'sk-123',
		})
		fireEvent.click(screen.getByRole('checkbox', { name: 'get_item_02' }))
		expect(screen.getByText('Selected: 2/20')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
		expect(mocks.update.mock.calls[0]?.[0].mcp_config.tools).toHaveLength(2)
	})

	it('pre-ticks 20 of 21 tools and blocks Save until the count is back to 20', async () => {
		mocks.probe.mockResolvedValue({ ok: true, tools: probeTools(21) })
		renderAdd()
		fillAndVerify()
		expect(await screen.findByText('Selected: 20/20')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
		fireEvent.click(screen.getByRole('checkbox', { name: 'get_item_20' }))
		expect(screen.getByText('Selected: 21/20')).toBeInTheDocument()
		expect(screen.getByRole('alert')).toHaveTextContent(
			'This extension exposes 21 tools. Cap is 20',
		)
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
	})

	it('shows the stored key masked on edit, with a Replace key button', () => {
		render(<McpDialog ext={wiredExtension()} workspaceId="ws-1" open onOpenChange={() => {}} />)
		expect(screen.getByText('Edit Fireflies MCP')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Change server or key' }))
		expect(screen.getByLabelText('API key (hidden)')).toBeInTheDocument()
		expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
		expect(screen.getByLabelText('API key')).toBeInTheDocument()
	})
})

describe('McpSection', () => {
	it('offers Add MCP when empty, using a recipe URL when one matches the slug', () => {
		render(
			<McpSection
				ext={buildExtension()}
				workspaceId="ws-1"
				recipes={[
					{
						slug: 'fireflies',
						displayName: 'Fireflies',
						docsUrl: 'https://docs.example',
						mcpConfig,
					},
				]}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Add MCP from the Fireflies recipe' }))
		expect(screen.getByLabelText('Server URL')).toHaveValue('https://api.fireflies.ai/mcp')
	})

	it('summarises a wired MCP with a masked key and its tools', () => {
		render(<McpSection ext={wiredExtension()} workspaceId="ws-1" recipes={[]} />)
		expect(screen.getByText('On · 2 tools')).toBeInTheDocument()
		expect(screen.getByText('On · 2 tools')).toHaveClass(
			'bg-status-live-bg',
			'text-status-live-text',
		)
		expect(screen.getByLabelText('API key (hidden)')).toBeInTheDocument()
		expect(screen.getByText('https://api.fireflies.ai/mcp')).toBeInTheDocument()
		expect(screen.getByText('bookmark_meeting')).toBeInTheDocument()
	})

	it('shows the yellow warning linking back to the MCP step when the runtime skipped it', () => {
		render(
			<McpSection
				ext={wiredExtension({ mcpLastError: 'tool cap exceeded: 21/20' })}
				workspaceId="ws-1"
				recipes={[]}
			/>,
		)
		expect(screen.getByRole('alert')).toHaveTextContent('tool cap exceeded: 21/20')
		expect(screen.getByText('Not attached')).not.toHaveClass('bg-status-live-bg')
		fireEvent.click(screen.getByRole('button', { name: 'Fix it in the MCP step' }))
		expect(screen.getByText('Edit Fireflies MCP')).toBeInTheDocument()
	})
})

describe('MCP in the progress card and list row', () => {
	it('adds an MCP step, and no delivery chip for an MCP-only extension', () => {
		render(<SetupProgressCard ext={wiredExtension()} />)
		expect(screen.getByText('MCP')).toBeInTheDocument()
		expect(screen.queryByText('Webhook')).not.toBeInTheDocument()
		expect(screen.queryByText('Waiting for first delivery')).not.toBeInTheDocument()
		expect(
			screen.getByText('Fireflies tools are ready. Grant agents access below.'),
		).toBeInTheDocument()
	})

	it('marks the MCP step not done until the key is stored', () => {
		render(<SetupProgressCard ext={wiredExtension({ hasMcpKey: false })} />)
		expect(screen.getByText('Finish the MCP to attach its tools.')).toBeInTheDocument()
	})

	it('reads On, N tools on the list row for an MCP-only extension', () => {
		expect(extensionRowStatus(wiredExtension()).label).toBe('On, 2 tools')
		expect(extensionRowStatus(wiredExtension()).variant).toBe('live')
		expect(extensionRowStatus(wiredExtension({ hasMcpKey: false })).label).toBe('Not configured')
	})
})
