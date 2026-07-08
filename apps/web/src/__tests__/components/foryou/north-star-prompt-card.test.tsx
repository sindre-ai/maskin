import { NorthStarPromptCard } from '@/components/foryou/north-star-prompt-card'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackImpressionMock = vi.fn()
const trackResponseMock = vi.fn()
const updateWorkspaceMock = vi.fn()
const onDismissMock = vi.fn()

vi.mock('@/lib/analytics', () => ({
	trackNorthStarPromptImpression: (p: { workspace_id: string }) => trackImpressionMock(p),
	trackNorthStarPromptResponse: (p: { workspace_id: string }) => trackResponseMock(p),
}))

vi.mock('@/lib/api', () => ({
	api: {
		workspaces: {
			update: (id: string, patch: unknown) => updateWorkspaceMock(id, patch),
		},
	},
}))

describe('NorthStarPromptCard', () => {
	beforeEach(() => {
		trackImpressionMock.mockReset()
		trackResponseMock.mockReset()
		updateWorkspaceMock.mockReset()
		updateWorkspaceMock.mockResolvedValue(undefined)
		onDismissMock.mockReset()
		localStorage.clear()
	})

	it('fires north_star_prompt_impression exactly once on mount with workspace_id', () => {
		const { rerender } = render(
			<NorthStarPromptCard workspaceId="ws-42" onDismiss={onDismissMock} />,
		)
		expect(trackImpressionMock).toHaveBeenCalledTimes(1)
		expect(trackImpressionMock).toHaveBeenCalledWith({ workspace_id: 'ws-42' })

		// Re-render with same workspaceId must not re-fire.
		rerender(<NorthStarPromptCard workspaceId="ws-42" onDismiss={onDismissMock} />)
		expect(trackImpressionMock).toHaveBeenCalledTimes(1)
	})

	it('fires north_star_prompt_response with workspace_id on submit and persists the answer', async () => {
		const user = userEvent.setup()
		render(<NorthStarPromptCard workspaceId="ws-42" onDismiss={onDismissMock} />)

		await user.type(screen.getByPlaceholderText('e.g. Weekly Active Users'), 'DAU')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => {
			expect(trackResponseMock).toHaveBeenCalledWith({ workspace_id: 'ws-42' })
		})
		expect(updateWorkspaceMock).toHaveBeenCalledWith('ws-42', {
			settings: { north_star_metric: 'DAU' },
		})
		expect(localStorage.getItem('north_star_answered_ws-42')).toBe('1')
		expect(onDismissMock).toHaveBeenCalledTimes(1)
	})

	it('does not fire the response event when input is blank', async () => {
		const user = userEvent.setup()
		render(<NorthStarPromptCard workspaceId="ws-42" onDismiss={onDismissMock} />)
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(trackResponseMock).not.toHaveBeenCalled()
		expect(updateWorkspaceMock).not.toHaveBeenCalled()
	})

	it('leaves the card open and does not persist when the workspace update rejects', async () => {
		updateWorkspaceMock.mockRejectedValue(new Error('network error'))
		const user = userEvent.setup()
		render(<NorthStarPromptCard workspaceId="ws-42" onDismiss={onDismissMock} />)

		await user.type(screen.getByPlaceholderText('e.g. Weekly Active Users'), 'DAU')
		await user.click(screen.getByRole('button', { name: 'Save' }))

		await waitFor(() => expect(updateWorkspaceMock).toHaveBeenCalled())
		// Response event still fires — it's an intent signal, not a confirmation.
		expect(trackResponseMock).toHaveBeenCalledTimes(1)
		expect(localStorage.getItem('north_star_answered_ws-42')).toBeNull()
		expect(onDismissMock).not.toHaveBeenCalled()
	})
})
