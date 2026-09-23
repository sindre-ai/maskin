import type { SpawnedSession } from '@/lib/api'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const shownMock = vi.fn()
const clickedMock = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackHandedOffStripShown: (p: unknown) => shownMock(p),
	trackHandedOffStripRowClicked: (p: unknown) => clickedMock(p),
}))

import { HandedOffStrip } from '@/components/chat/handed-off-strip'

function session(overrides: Partial<SpawnedSession> = {}): SpawnedSession {
	return {
		id: 's1',
		status: 'running',
		actorId: 'actor-1',
		actorName: 'Sentinel',
		actionPrompt: 'Check the deploy',
		startedAt: '2026-09-23T08:00:00.000Z',
		completedAt: null,
		durationMs: null,
		result: null,
		currentActivity: null,
		depends_on_session_ids: [],
		...overrides,
	}
}

function renderStrip(sessions: SpawnedSession[], messageId = 42) {
	return render(
		<HandedOffStrip workspaceId="ws-1" messageId={messageId} spawnedSessions={sessions} />,
		{ wrapper: TestWrapper },
	)
}

describe('HandedOffStrip', () => {
	beforeEach(() => {
		shownMock.mockReset()
		clickedMock.mockReset()
	})

	it('renders nothing on empty embed and fires no impression', () => {
		const { container } = renderStrip([])
		expect(container.firstChild).toBeNull()
		expect(shownMock).not.toHaveBeenCalled()
	})

	it('renders nothing when every session is v1-out-of-scope (BLOCKED/STOPPED)', () => {
		const { container } = renderStrip([
			session({ id: 'x', status: 'blocked' }),
			session({ id: 'y', status: 'stopped' }),
		])
		expect(container.firstChild).toBeNull()
		expect(shownMock).not.toHaveBeenCalled()
	})

	it('renders WORKING with a currentActivity clause', () => {
		renderStrip([
			session({
				status: 'running',
				currentActivity: 'reading events.ts',
				actorName: 'Sentinel',
			}),
		])
		expect(screen.getByText('WORKING')).toBeInTheDocument()
		expect(screen.getByText('· reading events.ts')).toBeInTheDocument()
	})

	it('renders QUEUED, DONE, and FAILED pills across a mixed strip', () => {
		renderStrip([
			session({ id: 'q1', status: 'pending', actorName: 'Aegis' }),
			session({
				id: 'd1',
				status: 'completed',
				actorName: 'Forge',
				durationMs: 45_000,
			}),
			session({
				id: 'f1',
				status: 'failed',
				actorName: 'Beacon',
				result: { failure_reason: 'quota exhausted' },
			}),
		])
		expect(screen.getByText('QUEUED')).toBeInTheDocument()
		expect(screen.getByText('DONE')).toBeInTheDocument()
		expect(screen.getByText('FAILED')).toBeInTheDocument()
		expect(screen.getByText('· quota exhausted')).toBeInTheDocument()
		// The DONE row surfaces its final elapsed inline. Its completion time
		// coming from `durationMs` (not startedAt) lets a completed row that
		// arrived without a startedAt still print a total.
		expect(screen.getByText('· 45s')).toBeInTheDocument()
	})

	it('renders the deps clause using resolved names within the same strip', () => {
		renderStrip([
			session({ id: 's1', status: 'completed', actorName: 'Sentinel' }),
			session({ id: 's2', status: 'completed', actorName: 'Forge' }),
			session({
				id: 's3',
				status: 'pending',
				actorName: 'Aegis',
				depends_on_session_ids: ['s1', 's2'],
			}),
		])
		expect(screen.getByText('· behind Sentinel and Forge')).toBeInTheDocument()
	})

	it('fires handed_off_strip_shown exactly once per bubble on first render', () => {
		const { rerender } = renderStrip([session({ status: 'running' })])
		expect(shownMock).toHaveBeenCalledTimes(1)
		expect(shownMock).toHaveBeenCalledWith({ messageId: 42, subAgentCount: 1 })
		// A re-render for a live SSE tick (status still WORKING with updated
		// currentActivity) must not inflate the impression counter.
		rerender(
			<HandedOffStrip
				workspaceId="ws-1"
				messageId={42}
				spawnedSessions={[session({ status: 'running', currentActivity: 'compiling' })]}
			/>,
		)
		expect(shownMock).toHaveBeenCalledTimes(1)
	})

	it('fires handed_off_strip_row_clicked with the row shape on row click', () => {
		renderStrip([session({ id: 's1', status: 'running', actorName: 'Sentinel' })])
		const row = screen.getByRole('link', { name: /Sub-agent Sentinel/ })
		fireEvent.click(row)
		expect(clickedMock).toHaveBeenCalledWith({
			messageId: 42,
			sessionId: 's1',
			subAgentActorId: 'actor-1',
			subAgentStatus: 'running',
		})
	})

	it('renders the mobile viewport at 375px without collapsing pill state', () => {
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
		window.dispatchEvent(new Event('resize'))
		renderStrip([session({ status: 'running', currentActivity: 'compiling' })])
		expect(screen.getByText('WORKING')).toBeInTheDocument()
		// The row keeps its label + pill on the smallest supported viewport —
		// the pill dropping to its own line via the row's flex-wrap is the
		// spec's mobile rule; render sanity here just ensures nothing throws
		// when the viewport is tight.
		expect(screen.getByText('Sentinel')).toBeInTheDocument()
	})
})
