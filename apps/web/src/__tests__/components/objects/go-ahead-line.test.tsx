import { GoAheadLine } from '@/components/objects/go-ahead-line'
import type { GoAhead } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const takeBackGoAhead = vi.fn()
vi.mock('@/lib/api', () => ({
	api: { objects: { takeBackGoAhead: (...args: unknown[]) => takeBackGoAhead(...args) } },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const goAhead = (over: Partial<GoAhead> = {}): GoAhead => ({
	id: 'g1',
	object_id: 'o1',
	granted_by: 'human-1',
	granted_by_name: 'Sebastian',
	via: 'chat',
	message_id: 42,
	granted_at: '2026-11-14T08:00:00.000Z',
	...over,
})

function renderLine(value: GoAhead | null | undefined) {
	const queryClient = new QueryClient()
	return render(
		<QueryClientProvider client={queryClient}>
			<GoAheadLine goAhead={value} objectId="o1" workspaceId="w1" />
		</QueryClientProvider>,
	)
}

describe('GoAheadLine', () => {
	beforeEach(() => {
		takeBackGoAhead.mockReset()
		takeBackGoAhead.mockResolvedValue(goAhead())
	})

	it('renders nothing when the job has no go-ahead', () => {
		const { container } = renderLine(null)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing when the field is missing (an older server)', () => {
		const { container } = renderLine(undefined)
		expect(container).toBeEmptyDOMElement()
	})

	it('names who gave it and when', () => {
		renderLine(goAhead())
		expect(document.querySelector('[data-go-ahead]')).toHaveTextContent(/Go-ahead from Sebastian,/)
		expect(screen.getByRole('button', { name: 'Take back' })).toBeInTheDocument()
	})

	it('takes the go-ahead back for this job in this workspace', async () => {
		renderLine(goAhead())
		fireEvent.click(screen.getByRole('button', { name: 'Take back' }))
		await waitFor(() => expect(takeBackGoAhead).toHaveBeenCalledWith('o1', 'w1'))
	})
})
