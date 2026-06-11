import { StreamingIndicator } from '@/components/shared/streaming-indicator'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const stopMutate = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useSession: vi.fn(() => ({ data: buildSessionResponse({ actorId: 'actor-1' }) })),
	useSessionLogs: vi.fn(() => ({ data: [] })),
	useStopSession: vi.fn(() => ({ mutate: stopMutate, isPending: false })),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: buildActorResponse({ name: 'Scout', type: 'agent' }) })),
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: vi.fn(() => '0:02'),
}))

describe('StreamingIndicator — Stop affordance', () => {
	beforeEach(() => {
		stopMutate.mockReset()
	})

	it('renders as a running pill with a Stop affordance', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		expect(screen.getByText(/Scout is working/)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Stop Scout/i })).toBeInTheDocument()
	})

	it('opens an inline labelled confirm on Stop tap (no modal)', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })

		fireEvent.click(screen.getByRole('button', { name: /Stop Scout/i }))

		expect(screen.getByText('Stop Scout?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
	})

	it('Esc cancels the confirm without stopping', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		fireEvent.click(screen.getByRole('button', { name: /Stop Scout/i }))

		fireEvent.keyDown(window, { key: 'Escape' })

		expect(screen.queryByText('Stop Scout?')).not.toBeInTheDocument()
		expect(stopMutate).not.toHaveBeenCalled()
	})

	it('confirming flips the pill to Stopping… and fires the mutation', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		fireEvent.click(screen.getByRole('button', { name: /Stop Scout/i }))

		fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

		expect(stopMutate).toHaveBeenCalledWith('s1', expect.any(Object))
		expect(screen.getByText('Stopping Scout…')).toBeInTheDocument()
	})

	it('hides the Stop affordance while stopping', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		fireEvent.click(screen.getByRole('button', { name: /Stop Scout/i }))
		fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

		expect(screen.queryByRole('button', { name: /Stop Scout/i })).not.toBeInTheDocument()
	})

	it('Cancel returns to the running pill without firing stop', () => {
		render(<StreamingIndicator sessionId="s1" workspaceId="ws-1" />, { wrapper: TestWrapper })
		fireEvent.click(screen.getByRole('button', { name: /Stop Scout/i }))
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(screen.getByText(/Scout is working/)).toBeInTheDocument()
		expect(stopMutate).not.toHaveBeenCalled()
	})
})
