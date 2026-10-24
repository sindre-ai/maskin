import { AgentAccessSection } from '@/components/extensions/agent-access-section'
import { GrantAgentDialog } from '@/components/extensions/grant-agent-dialog'
import { SetupProgressCard } from '@/components/extensions/setup-progress-card'
import type { ExtensionResponse } from '@/lib/api'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOOLS = [
	{ name: 'get_transcript', kind: 'read' as const },
	{ name: 'list_transcripts', kind: 'read' as const },
	{ name: 'bookmark_meeting', kind: 'write' as const },
]

const mocks = vi.hoisted(() => ({
	actors: [] as { id: string; type: string; name: string }[],
	attempted: undefined as unknown,
	setGrant: vi.fn(),
	revoke: vi.fn(),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: mocks.actors, isLoading: false }),
}))

vi.mock('@/hooks/use-extensions', () => ({
	useExtensionAttempted: () => ({ data: mocks.attempted }),
	useSetAgentGrant: () => ({ mutateAsync: mocks.setGrant, isPending: false }),
	useRevokeAgentGrant: () => ({ mutateAsync: mocks.revoke, isPending: false }),
}))

function buildExtension(overrides: Partial<ExtensionResponse> = {}): ExtensionResponse {
	return {
		id: 'ext-1',
		workspaceId: 'ws-1',
		slug: 'fireflies',
		name: 'Fireflies',
		status: 'active',
		mcpConfig: { tools: TOOLS },
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

describe('GrantAgentDialog', () => {
	const baseProps = {
		open: true,
		onOpenChange: () => {},
		agentName: 'Meeting Analyst',
		extensionName: 'Fireflies',
		tools: TOOLS,
		initial: { get_transcript: true, list_transcripts: true, bookmark_meeting: false },
		pending: false,
	}

	it('is titled with the agent and extension, and pre-checks read tools only', () => {
		render(<GrantAgentDialog {...baseProps} onSubmit={() => {}} />)
		expect(screen.getByText('Grant Meeting Analyst → Fireflies')).toBeInTheDocument()
		expect(screen.getByRole('checkbox', { name: 'get_transcript' })).toBeChecked()
		expect(screen.getByRole('checkbox', { name: 'list_transcripts' })).toBeChecked()
		expect(screen.getByRole('checkbox', { name: 'bookmark_meeting' })).not.toBeChecked()
		expect(screen.getByRole('button', { name: 'Grant 2 tools' })).toBeEnabled()
		expect(screen.getByText(/Write tools are opt-in per grant/)).toBeInTheDocument()
	})

	it('opts a write tool in and submits the selection', () => {
		const onSubmit = vi.fn()
		render(<GrantAgentDialog {...baseProps} onSubmit={onSubmit} />)
		fireEvent.click(screen.getByRole('checkbox', { name: 'bookmark_meeting' }))
		fireEvent.click(screen.getByRole('button', { name: 'Grant 3 tools' }))
		expect(onSubmit).toHaveBeenCalledWith({
			get_transcript: true,
			list_transcripts: true,
			bookmark_meeting: true,
		})
	})

	it('cannot submit with nothing checked', () => {
		render(
			<GrantAgentDialog
				{...baseProps}
				initial={{ get_transcript: false, list_transcripts: false, bookmark_meeting: false }}
				onSubmit={() => {}}
			/>,
		)
		expect(screen.getByRole('button', { name: 'Grant 0 tools' })).toBeDisabled()
	})
})

describe('AgentAccessSection', () => {
	beforeEach(() => {
		mocks.actors = [
			{ id: 'a1', type: 'agent', name: 'Meeting Analyst' },
			{ id: 'a2', type: 'agent', name: 'Sales Rep' },
			{ id: 'h1', type: 'human', name: 'Sebastian' },
		]
		mocks.attempted = undefined
		mocks.setGrant.mockReset().mockResolvedValue({})
		mocks.revoke.mockReset().mockResolvedValue({})
	})

	it('lists every agent, off and Blocked, and no humans (default deny)', () => {
		render(<AgentAccessSection ext={buildExtension()} workspaceId="ws-1" />)
		expect(screen.getByText('Default deny')).toBeInTheDocument()
		expect(screen.getByText('Meeting Analyst')).toBeInTheDocument()
		expect(screen.getByText('Sales Rep')).toBeInTheDocument()
		expect(screen.queryByText('Sebastian')).not.toBeInTheDocument()
		expect(screen.getAllByText('Blocked')).toHaveLength(2)
		for (const toggle of screen.getAllByRole('switch')) {
			expect(toggle).toHaveAttribute('aria-checked', 'false')
		}
		expect(screen.queryByText('Attempted')).not.toBeInTheDocument()
	})

	it('shows Allowed with the granted count for an agent holding allowed tools', () => {
		const ext = buildExtension({
			toolGrants: { a1: { get_transcript: 'allow', bookmark_meeting: 'deny' } },
		})
		render(<AgentAccessSection ext={ext} workspaceId="ws-1" />)
		expect(screen.getByText('Allowed')).toBeInTheDocument()
		expect(screen.getByText('Granted 1 of 3 tools')).toBeInTheDocument()
	})

	it('lights the Attempted chip after a recorded denial, and Grant opens the modal for that agent', () => {
		mocks.attempted = {
			windowDays: 30,
			agents: [
				{ agentId: 'a2', tools: ['bookmark_meeting'], lastAttemptedAt: new Date().toISOString() },
			],
		}
		render(<AgentAccessSection ext={buildExtension()} workspaceId="ws-1" />)
		expect(screen.getAllByText('Attempted')).toHaveLength(1)
		expect(screen.getByText('bookmark_meeting', { selector: 'span.font-mono' })).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Grant' }))
		const dialog = screen.getByRole('dialog')
		expect(within(dialog).getByText('Grant Sales Rep → Fireflies')).toBeInTheDocument()
		expect(within(dialog).getByRole('checkbox', { name: 'get_transcript' })).toBeChecked()
		expect(within(dialog).getByRole('checkbox', { name: 'bookmark_meeting' })).not.toBeChecked()
	})

	it('saves the checked tools as explicit allow and deny', async () => {
		render(<AgentAccessSection ext={buildExtension()} workspaceId="ws-1" />)
		fireEvent.click(screen.getAllByRole('switch')[0] as HTMLElement)
		fireEvent.click(screen.getByRole('button', { name: 'Grant 2 tools' }))
		await vi.waitFor(() => expect(mocks.setGrant).toHaveBeenCalledTimes(1))
		expect(mocks.setGrant).toHaveBeenCalledWith({
			agentId: 'a1',
			tools: { get_transcript: 'allow', list_transcripts: 'allow', bookmark_meeting: 'deny' },
		})
	})

	it('removes access when an allowed agent is switched off', async () => {
		const ext = buildExtension({ toolGrants: { a1: { get_transcript: 'allow' } } })
		render(<AgentAccessSection ext={ext} workspaceId="ws-1" />)
		fireEvent.click(screen.getAllByRole('switch')[0] as HTMLElement)
		await vi.waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith('a1'))
	})

	it('opens the bulk grant placeholder without wiring it', () => {
		render(<AgentAccessSection ext={buildExtension()} workspaceId="ws-1" />)
		fireEvent.click(screen.getByRole('button', { name: 'Bulk grant…' }))
		const dialog = screen.getByRole('dialog')
		expect(within(dialog).getByText(/Not available yet/)).toBeInTheDocument()
		expect(within(dialog).getByRole('button', { name: 'Grant' })).toBeDisabled()
	})

	it('says so when the extension declares no tools', () => {
		render(<AgentAccessSection ext={buildExtension({ mcpConfig: null })} workspaceId="ws-1" />)
		expect(screen.getByText(/This extension has no MCP tools yet/)).toBeInTheDocument()
		expect(screen.queryAllByRole('switch')).toHaveLength(0)
	})
})

describe('SetupProgressCard Access step', () => {
	it('is left out when the extension declares no tools', () => {
		render(<SetupProgressCard ext={buildExtension({ mcpConfig: null })} />)
		expect(screen.queryByText('Access')).not.toBeInTheDocument()
	})

	it('is not done while no agent holds an allowed tool', () => {
		render(
			<SetupProgressCard
				ext={buildExtension({ toolGrants: { a1: { bookmark_meeting: 'deny' } } })}
			/>,
		)
		expect(screen.getByText('Access').parentElement).toHaveTextContent('not done')
	})

	it('is done once an agent holds an allowed tool', () => {
		render(
			<SetupProgressCard
				ext={buildExtension({ toolGrants: { a1: { get_transcript: 'allow' } } })}
			/>,
		)
		expect(screen.getByText('Access').parentElement).toHaveTextContent('done')
		expect(screen.getByText('Access').parentElement).not.toHaveTextContent('not done')
	})
})
