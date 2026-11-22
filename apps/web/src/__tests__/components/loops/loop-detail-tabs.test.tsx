import { LoopDetailTabs } from '@/components/loops/loop-detail-tabs'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const tabs = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'setup', label: 'Setup' },
	{ value: 'view-0', label: 'Results', startsGroup: true },
]

describe('LoopDetailTabs', () => {
	it('adds a view from the + button', async () => {
		const onAdd = vi.fn()
		render(
			<LoopDetailTabs
				tabs={tabs}
				value="overview"
				onChange={() => {}}
				onAdd={onAdd}
				addLabel="Ask for a new view"
			/>,
		)
		await userEvent.click(screen.getByRole('button', { name: 'Ask for a new view' }))
		expect(onAdd).toHaveBeenCalled()
	})

	it('offers no + button without an onAdd', () => {
		render(<LoopDetailTabs tabs={tabs} value="overview" onChange={() => {}} addLabel="Add" />)
		expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
	})
})
