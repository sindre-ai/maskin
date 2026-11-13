import { LoopViewTab } from '@/components/loops/loop-view-tab'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/loops/loop-custom-view', () => ({
	LoopCustomView: ({
		fileId,
		onFailure,
	}: { fileId: string; onFailure: (reason: string) => void }) => {
		useEffect(() => {
			if (fileId === 'bad') onFailure('The view file is not an HTML file.')
		}, [fileId, onFailure])
		return <div data-testid="view" />
	},
}))

describe('LoopViewTab', () => {
	it('renders the view with no note when it loads', () => {
		render(<LoopViewTab workspaceId="w" fileId="good" />)
		expect(screen.getByTestId('view')).toBeInTheDocument()
		expect(screen.queryByRole('alert')).toBeNull()
	})

	it('says in its own tab why a view cannot be shown', () => {
		render(<LoopViewTab workspaceId="w" fileId="bad" />)
		expect(screen.getByRole('alert')).toHaveTextContent(
			"This view can't be shown: The view file is not an HTML file.",
		)
		expect(screen.queryByTestId('view')).toBeNull()
	})

	it('offers rename and remove from the ··· menu', async () => {
		const onRename = vi.fn()
		const onRemove = vi.fn()
		const user = userEvent.setup()
		render(
			<LoopViewTab
				workspaceId="w"
				fileId="good"
				name="Results"
				onRename={onRename}
				onRemove={onRemove}
			/>,
		)
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Rename/ }))
		const input = screen.getByLabelText('View name')
		await user.clear(input)
		await user.type(input, 'Scorecard')
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(onRename).toHaveBeenCalledWith('Scorecard')

		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Remove view/ }))
		expect(onRemove).toHaveBeenCalled()
	})

	it('shows no menu for a view the flow does not own', () => {
		render(<LoopViewTab workspaceId="w" fileId="good" name="Briefings" />)
		expect(screen.queryByRole('button', { name: 'View actions' })).not.toBeInTheDocument()
	})
})
