import { BranchSwitcher } from '@/components/chat/branch-switcher'
import type { BranchPoint } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const switchBranch = vi.fn()

vi.mock('@/hooks/use-conversation', () => ({
	useSwitchBranch: () => ({ mutate: switchBranch, isPending: false }),
}))

function buildBranchPoint(overrides: Partial<BranchPoint> = {}): BranchPoint {
	return {
		messageId: 42,
		activeIndex: 1,
		options: [{ branchId: null }, { branchId: 'branch-a' }],
		...overrides,
	}
}

function renderSwitcher(branchPoint: BranchPoint) {
	return render(
		<BranchSwitcher workspaceId="ws-1" conversationId="convo-1" branchPoint={branchPoint} />,
		{ wrapper: TestWrapper },
	)
}

describe('BranchSwitcher', () => {
	it('shows the reader which version of the tail they are on', () => {
		renderSwitcher(buildBranchPoint())
		expect(screen.getByText('2/2')).toBeInTheDocument()
	})

	it('switches to the previous version, which is the original continuation', async () => {
		switchBranch.mockClear()
		renderSwitcher(buildBranchPoint())
		await userEvent.click(screen.getByLabelText('Previous version'))
		// Option 0 is always the root/original branch, addressed as null.
		expect(switchBranch).toHaveBeenCalledWith({ branchId: null })
	})

	it('disables the arrow at each end rather than wrapping around', () => {
		renderSwitcher(buildBranchPoint({ activeIndex: 0 }))
		expect(screen.getByLabelText('Previous version')).toBeDisabled()
		expect(screen.getByLabelText('Next version')).toBeEnabled()
	})

	it('renders nothing when there is only one version — that is not a fork', () => {
		const { container } = renderSwitcher(
			buildBranchPoint({ activeIndex: 0, options: [{ branchId: null }] }),
		)
		expect(container).toBeEmptyDOMElement()
	})
})
