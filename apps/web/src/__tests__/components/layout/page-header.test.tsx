import { PageHeader } from '@/components/layout/page-header'
import { render } from '@testing-library/react'

const mockSetActions = vi.fn()

vi.mock('@/lib/page-header-context', () => ({
	usePageHeader: () => ({ setActions: mockSetActions }),
}))

describe('PageHeader', () => {
	beforeEach(() => {
		mockSetActions.mockClear()
	})

	it('calls setActions on mount with provided actions', () => {
		const actions = <button type="button">Delete</button>
		render(<PageHeader actions={actions} />)
		expect(mockSetActions).toHaveBeenCalledWith(actions)
	})

	it('calls setActions with null when no actions provided', () => {
		render(<PageHeader />)
		expect(mockSetActions).toHaveBeenCalledWith(null)
	})

	it('calls setActions(null) on unmount', () => {
		const { unmount } = render(<PageHeader actions={<span>X</span>} />)
		mockSetActions.mockClear()
		unmount()
		expect(mockSetActions).toHaveBeenCalledWith(null)
	})

	it('renders nothing visible', () => {
		const { container } = render(<PageHeader />)
		expect(container.firstChild).toBeNull()
	})
})
