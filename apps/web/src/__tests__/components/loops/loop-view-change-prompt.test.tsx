import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { objects: { get: (id: string) => get(id) } } }))
const track = vi.fn()
vi.mock('@/lib/analytics', () => ({ trackLoopViewCardAction: (p: unknown) => track(p) }))
const mutate = vi.fn()
const reset = vi.fn()
const update = vi.hoisted(() => ({ error: null as Error | null, isPending: false }))
vi.mock('@/hooks/use-objects', () => ({
	useUpdateObject: () => ({ mutate, reset, error: update.error, isPending: update.isPending }),
}))

import { LoopViewChangePrompt, formatDay } from '@/components/loops/loop-view-change-prompt'
import type { ProposedChange } from '@/lib/loop-view-bridge'

const year = new Date().getUTCFullYear()
const post = {
	id: 'obj-1',
	workspaceId: 'ws',
	type: 'content',
	title: 'Launch post',
	status: 'proposed',
	metadata: { scheduled_date: `${year}-11-12`, post_time: '08:00' },
}
const date: ProposedChange = { id: 'obj-1', field: 'scheduled_date', value: `${year}-11-14` }

function renderPrompt(
	change: ProposedChange | null,
	handlers = { onCancel: vi.fn(), onSaved: vi.fn() },
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const wrap = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
	render(<LoopViewChangePrompt workspaceId="ws" loopId="loop-1" change={change} {...handlers} />, {
		wrapper: wrap,
	})
	return handlers
}

describe('formatDay', () => {
	it('writes a plain day with no time zone shift', () => {
		expect(formatDay(`${year}-11-14`)).toBe('14 Nov')
		expect(formatDay('2031-01-01')).toBe('1 Jan 2031')
	})
})

describe('LoopViewChangePrompt', () => {
	beforeEach(() => {
		get.mockReset().mockResolvedValue(post)
		mutate.mockReset()
		reset.mockReset()
		track.mockReset()
		update.error = null
		update.isPending = false
	})

	it('asks nothing and saves nothing while no change is proposed', () => {
		renderPrompt(null)
		expect(screen.queryByRole('dialog')).toBeNull()
		expect(get).not.toHaveBeenCalled()
		expect(mutate).not.toHaveBeenCalled()
	})

	it('asks the question in its own words, from the item, before saving anything', async () => {
		renderPrompt(date)
		expect(await screen.findByText('Move to 14 Nov?')).toBeInTheDocument()
		expect(await screen.findByText(/Launch post/)).toHaveTextContent('now 12')
		expect(mutate).not.toHaveBeenCalled()
		expect(track).not.toHaveBeenCalled()
	})

	it('saves only that one field, only if the status is unchanged, after counting the click', async () => {
		const { onSaved } = renderPrompt(date)
		const move = await screen.findByRole('button', { name: 'Move' })
		await waitFor(() => expect(move).toBeEnabled())
		fireEvent.click(move)

		expect(track).toHaveBeenCalledWith({
			entity_id: 'obj-1',
			object_type: 'content',
			loop_id: 'loop-1',
			action: 'date_change',
		})
		expect(mutate).toHaveBeenCalledTimes(1)
		expect(mutate.mock.calls[0]?.[0]).toEqual({
			id: 'obj-1',
			data: { metadata: { scheduled_date: `${year}-11-14` }, expected_status: 'proposed' },
		})
		expect(track.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0] ?? 0)
		// The caller hears about success only through the mutation's own callback.
		expect(onSaved).not.toHaveBeenCalled()
		mutate.mock.calls[0]?.[1]?.onSuccess()
		expect(onSaved).toHaveBeenCalled()
	})

	it('asks for a post time in its own words', async () => {
		renderPrompt({ id: 'obj-1', field: 'post_time', value: '09:30' })
		expect(await screen.findByText('Set post time to 09:30?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Set time' })).toBeInTheDocument()
	})

	it('saves nothing and counts nothing on Cancel', async () => {
		const { onCancel, onSaved } = renderPrompt(date)
		await screen.findByText(/Launch post/)
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(onCancel).toHaveBeenCalled()
		expect(onSaved).not.toHaveBeenCalled()
		expect(mutate).not.toHaveBeenCalled()
		expect(track).not.toHaveBeenCalled()
	})

	it('cannot be confirmed for an item in another workspace', async () => {
		get.mockResolvedValue({ ...post, workspaceId: 'other' })
		renderPrompt(date)
		expect(await screen.findByText(/Can't find this item/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
	})

	it('says why when the save is refused', async () => {
		update.error = new Error('This item is no longer proposed.')
		renderPrompt(date)
		expect(await screen.findByRole('alert')).toHaveTextContent('no longer proposed')
	})
})
