import {
	AgentPortraitCard,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse, buildSessionResponse } from '../../factories'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '5m 30s',
}))

describe('AgentPortraitCard', () => {
	const noop = () => {}

	it('renders agent name and role from systemPrompt first line', () => {
		const agent = buildActorResponse({
			name: 'Scout',
			type: 'agent',
			system_prompt: 'Monitors production alerts\nDoes other things',
		})
		render(<AgentPortraitCard agent={agent} status="idle" onRun={noop} onPause={noop} />)
		expect(screen.getByText('Scout')).toBeInTheDocument()
		expect(screen.getByText('Monitors production alerts')).toBeInTheDocument()
	})

	it('shows Run button when status is idle', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentPortraitCard agent={agent} status="idle" onRun={noop} onPause={noop} />)
		expect(screen.getByRole('button', { name: /Run/ })).toBeInTheDocument()
	})

	it('shows Resume button when status is paused', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentPortraitCard agent={agent} status="paused" onRun={noop} onPause={noop} />)
		expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument()
	})

	it('shows Pause button when status is running', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentPortraitCard agent={agent} status="running" onRun={noop} onPause={noop} />)
		expect(screen.getByRole('button', { name: /Pause/ })).toBeInTheDocument()
	})

	it('calls onRun when Run is clicked, without navigating', async () => {
		const agent = buildActorResponse({ type: 'agent' })
		const onRun = vi.fn()
		const user = userEvent.setup()
		render(<AgentPortraitCard agent={agent} status="idle" onRun={onRun} onPause={noop} />)
		await user.click(screen.getByRole('button', { name: /Run/ }))
		expect(onRun).toHaveBeenCalledTimes(1)
	})

	it('calls onPause when Pause is clicked', async () => {
		const agent = buildActorResponse({ type: 'agent' })
		const onPause = vi.fn()
		const user = userEvent.setup()
		render(<AgentPortraitCard agent={agent} status="running" onRun={noop} onPause={onPause} />)
		await user.click(screen.getByRole('button', { name: /Pause/ }))
		expect(onPause).toHaveBeenCalledTimes(1)
	})

	it('disables the action button while pending', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(
			<AgentPortraitCard agent={agent} status="idle" onRun={noop} onPause={noop} isRunPending />,
		)
		const button = screen.getByRole('button', { name: /Starting/ })
		expect(button).toBeDisabled()
	})

	it('shows the failure focus line for failed status', () => {
		const agent = buildActorResponse({ type: 'agent' })
		const session = buildSessionResponse({ actionPrompt: 'Run nightly export' })
		render(
			<AgentPortraitCard
				agent={agent}
				status="failed"
				latestSession={session}
				onRun={noop}
				onPause={noop}
			/>,
		)
		expect(screen.getByText(/Failed: Run nightly export/)).toBeInTheDocument()
	})

	it('shows the action prompt when running', () => {
		const agent = buildActorResponse({ type: 'agent' })
		const session = buildSessionResponse({
			actionPrompt: 'Analyzing data',
			startedAt: '2026-01-01T00:00:00Z',
		})
		render(
			<AgentPortraitCard
				agent={agent}
				status="running"
				latestSession={session}
				onRun={noop}
				onPause={noop}
			/>,
		)
		expect(screen.getByText(/Analyzing data/)).toBeInTheDocument()
	})

	it('renders a touch-friendly action button (≥44px)', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentPortraitCard agent={agent} status="idle" onRun={noop} onPause={noop} />)
		const button = screen.getByRole('button', { name: /Run/ })
		expect(button.className).toContain('min-h-[44px]')
	})
})

describe('getPortraitStatus', () => {
	it('prefers running agentState', () => {
		expect(getPortraitStatus({ agentState: 'running' }, 'idle')).toBe('running')
	})

	it('prefers paused agentState', () => {
		expect(getPortraitStatus({ agentState: 'paused' }, 'working')).toBe('paused')
	})

	it('prefers failed agentState', () => {
		expect(getPortraitStatus({ agentState: 'failed' }, 'idle')).toBe('failed')
	})

	it('falls back to session-derived working when agentState is idle/missing', () => {
		expect(getPortraitStatus({}, 'working')).toBe('running')
		expect(getPortraitStatus({ agentState: 'idle' }, 'working')).toBe('running')
	})

	it('falls back to session-derived failed when agentState is idle', () => {
		expect(getPortraitStatus({ agentState: 'idle' }, 'failed')).toBe('failed')
	})

	it('returns idle when nothing else applies', () => {
		expect(getPortraitStatus({}, 'idle')).toBe('idle')
	})
})

describe('portraitStatusToFilter', () => {
	it('maps running to working', () => {
		expect(portraitStatusToFilter('running')).toBe('working')
	})

	it('maps failed to failed', () => {
		expect(portraitStatusToFilter('failed')).toBe('failed')
	})

	it('maps paused to idle (no separate paused tab)', () => {
		expect(portraitStatusToFilter('paused')).toBe('idle')
	})

	it('maps idle to idle', () => {
		expect(portraitStatusToFilter('idle')).toBe('idle')
	})
})
