import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
const track = vi.fn()
vi.mock('@/lib/analytics', () => ({ trackLoopViewCardAction: (p: unknown) => track(p) }))
vi.mock('@/components/chat/linked-object-preview', () => ({
	LinkedObjectCard: ({
		objectId,
		standalone,
		onAction,
	}: {
		objectId: string
		standalone?: boolean
		onAction?: (a: 'status_change' | 'approve') => void
	}) => (
		<div data-testid="card" data-standalone={standalone ? 'yes' : 'no'}>
			{objectId}
			<button type="button" onClick={() => onAction?.('approve')}>
				approve
			</button>
		</div>
	),
}))

import { LoopViewItemPanel } from '@/components/loops/loop-view-item-panel'

const base = { workspaceId: 'ws', loopId: 'loop-1', objectId: 'obj-1', onClose: vi.fn() }

describe('LoopViewItemPanel', () => {
	beforeEach(() => {
		useObject.mockReset()
		track.mockReset()
	})

	it('shows the item as a standalone card and counts one open', () => {
		useObject.mockReturnValue({ data: { id: 'obj-1', workspaceId: 'ws', type: 'bet' } })
		const { rerender } = render(<LoopViewItemPanel {...base} />)
		expect(screen.getByTestId('card')).toHaveAttribute('data-standalone', 'yes')
		rerender(<LoopViewItemPanel {...base} />)
		expect(track).toHaveBeenCalledTimes(1)
		expect(track).toHaveBeenCalledWith({
			entity_id: 'obj-1',
			object_type: 'bet',
			loop_id: 'loop-1',
			action: 'open',
		})
	})

	it('counts each action the card reports, with the item and loop ids', () => {
		useObject.mockReturnValue({ data: { id: 'obj-1', workspaceId: 'ws', type: 'bet' } })
		render(<LoopViewItemPanel {...base} />)
		fireEvent.click(screen.getByText('approve'))
		expect(track).toHaveBeenLastCalledWith({
			entity_id: 'obj-1',
			object_type: 'bet',
			loop_id: 'loop-1',
			action: 'approve',
		})
	})

	it('says so, and counts nothing, for an item that is missing or in another workspace', () => {
		useObject.mockReturnValue({ data: { id: 'obj-1', workspaceId: 'other', type: 'bet' } })
		render(<LoopViewItemPanel {...base} />)
		expect(screen.getByText("Can't open this item")).toBeInTheDocument()
		expect(screen.queryByTestId('card')).toBeNull()
		expect(track).not.toHaveBeenCalled()
	})

	it('closes', () => {
		useObject.mockReturnValue({ data: { id: 'obj-1', workspaceId: 'ws', type: 'bet' } })
		render(<LoopViewItemPanel {...base} />)
		fireEvent.click(screen.getByRole('button', { name: /Close/ }))
		expect(base.onClose).toHaveBeenCalled()
	})
})
