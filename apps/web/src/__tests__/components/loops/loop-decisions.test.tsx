import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { LoopDecisions } from '@/components/loops/loop-decisions'
import { buildActorListItem } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const researcher = buildActorListItem({ id: 'res', name: 'Researcher', type: 'agent' })

const row = (n: number, type = 'task') => ({
	item: { id: `item-${n}`, title: `Draft page ${n}`, type },
	ask: { title: `Ok to publish ${n}?`, createdAt: '2026-11-01T10:00:00Z', sourceActorId: 'res' },
})

function renderCard(rows: ReturnType<typeof row>[], onMessage?: () => void) {
	return render(
		<LoopDecisions
			workspaceId="ws-1"
			rows={rows}
			actors={[researcher]}
			messageLabel="Researcher"
			onMessage={onMessage}
		/>,
		{ wrapper: createWorkspaceWrapper({ id: 'ws-1', settings: {} }) },
	)
}

describe('LoopDecisions', () => {
	it('renders nothing when nothing waits', () => {
		const { container } = renderCard([])
		expect(container).toBeEmptyDOMElement()
	})

	it('titles the card by what waits, with the agent and the oldest wait', () => {
		renderCard([row(1), row(2), row(3)])

		expect(screen.getByText('3 tasks are waiting for you')).toBeInTheDocument()
		expect(screen.getByText('Researcher')).toBeInTheDocument()
		expect(screen.getByText(/oldest waiting/)).toBeInTheDocument()
	})

	it('reads in the singular for one, and says "items" for a mix of types', () => {
		const { unmount } = renderCard([row(1)])
		expect(screen.getByText('1 task is waiting for you')).toBeInTheDocument()
		unmount()

		renderCard([row(1), row(2, 'bet')])
		expect(screen.getByText('2 items are waiting for you')).toBeInTheDocument()
	})

	it('lists each item with the question it is asked, as a link to the item', () => {
		renderCard([row(1), row(2)])

		expect(screen.getByRole('link', { name: /Draft page 1/ })).toBeInTheDocument()
		expect(screen.getByText('Ok to publish 2?')).toBeInTheDocument()
	})

	it('selects all and clears, and counts the selection', () => {
		renderCard([row(1), row(2)])

		fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
		expect(screen.getByText('2 selected')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
		expect(screen.queryByText(/selected/)).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole('checkbox', { name: 'Select Draft page 1' }))
		expect(screen.getByText('1 selected')).toBeInTheDocument()
	})

	it('offers Message only when the host can bring the composer into reach', () => {
		const onMessage = vi.fn()
		const { unmount } = renderCard([row(1)])
		expect(screen.queryByRole('button', { name: /Message/ })).not.toBeInTheDocument()
		unmount()

		renderCard([row(1)], onMessage)
		fireEvent.click(screen.getByRole('button', { name: 'Message Researcher' }))
		expect(onMessage).toHaveBeenCalledTimes(1)
	})
})
