import { SpawnBar, SpawnChip, deriveMessageSpawnMap } from '@/components/chat/spawn-indicator'
import type { SessionResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildSessionResponse } from '../../factories'

describe('deriveMessageSpawnMap', () => {
	it('maps sessions to the message id in config.conversation.message_id', () => {
		const sessions = [
			buildSessionResponse({
				id: 'sess-a',
				status: 'running',
				startedAt: '2026-09-22T10:00:00Z',
				config: { conversation: { message_id: 101, conversation_id: 'c-1' } },
			}),
			buildSessionResponse({
				id: 'sess-b',
				status: 'completed',
				startedAt: '2026-09-22T09:00:00Z',
				completedAt: '2026-09-22T09:01:00Z',
				config: { conversation: { message_id: 102, conversation_id: 'c-1' } },
			}),
		] as SessionResponse[]

		const map = deriveMessageSpawnMap(sessions)
		expect(map.get(101)?.sessionId).toBe('sess-a')
		expect(map.get(102)?.sessionId).toBe('sess-b')
		expect(map.size).toBe(2)
	})

	it('skips sessions with no spawning messageId (autonomous / cron origin)', () => {
		const sessions = [
			buildSessionResponse({ id: 'sess-x', config: {} }),
			buildSessionResponse({ id: 'sess-y', config: { conversation: {} } }),
		] as SessionResponse[]
		expect(deriveMessageSpawnMap(sessions).size).toBe(0)
	})

	it('keeps the earliest session when two sessions were spawned from the same message', () => {
		const sessions = [
			buildSessionResponse({
				id: 'later',
				startedAt: '2026-09-22T10:00:00Z',
				config: { conversation: { message_id: 55 } },
			}),
			buildSessionResponse({
				id: 'earlier',
				startedAt: '2026-09-22T08:00:00Z',
				config: { conversation: { message_id: 55 } },
			}),
		] as SessionResponse[]
		expect(deriveMessageSpawnMap(sessions).get(55)?.sessionId).toBe('earlier')
	})
})

describe('SpawnChip', () => {
	const chipFor = (status: string) => (
		<SpawnChip
			info={{
				sessionId: 's-1',
				status,
				startedAt: '2026-09-22T10:00:00Z',
				completedAt: status === 'completed' ? '2026-09-22T10:00:12Z' : null,
			}}
		/>
	)

	it.each(['starting', 'running', 'snapshotting', 'completed', 'waiting_for_input'])(
		'renders nothing for a %s session, the tool calls already show it',
		(status) => {
			render(chipFor(status))
			expect(screen.queryByTestId('spawn-chip')).toBeNull()
		},
	)

	it('still shows a failed session ("Session started · <duration> · failed")', () => {
		render(chipFor('failed'))
		expect(screen.getByTestId('spawn-chip')).toHaveTextContent(/Session started · .* · failed/)
	})

	it('still shows a queued session', () => {
		render(chipFor('queued'))
		expect(screen.getByTestId('spawn-chip')).toHaveTextContent(/Session started/)
	})

	it('shows a stopped session with a readable label', () => {
		render(chipFor('user_stopped'))
		expect(screen.getByTestId('spawn-chip')).toHaveTextContent(/· stopped/)
	})

	it('omits the duration segment when startedAt is null (never-started session)', () => {
		render(
			<SpawnChip
				info={{
					sessionId: 's-1',
					status: 'failed',
					startedAt: null,
					completedAt: null,
				}}
			/>,
		)
		// Two `·` = start-status pair; no middle duration segment.
		expect(screen.getByTestId('spawn-chip').textContent).toBe('Session started · failed')
	})
})

describe('SpawnBar', () => {
	it('renders a decorative w-1 h-full brand bar', () => {
		const { container } = render(<SpawnBar />)
		const bar = container.querySelector('[data-testid="spawn-bar"]')
		expect(bar).not.toBeNull()
		expect(bar).toHaveClass('w-1')
		expect(bar).toHaveClass('h-full')
		expect(bar).toHaveClass('bg-brand')
		expect(bar).toHaveAttribute('aria-hidden', 'true')
	})
})
