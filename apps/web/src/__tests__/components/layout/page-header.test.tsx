import { PageHeader } from '@/components/layout/page-header'
import { render } from '@testing-library/react'

const mockSetActions = vi.fn()
const mockSetStickyIdentity = vi.fn()
const mockSetContentPush = vi.fn()
const mockSetScrollLocked = vi.fn()

vi.mock('@/lib/page-header-context', () => ({
	usePageHeader: () => ({
		setActions: mockSetActions,
		setStickyIdentity: mockSetStickyIdentity,
		setContentPush: mockSetContentPush,
		setScrollLocked: mockSetScrollLocked,
	}),
}))

describe('PageHeader', () => {
	beforeEach(() => {
		mockSetActions.mockClear()
		mockSetStickyIdentity.mockClear()
		mockSetContentPush.mockClear()
		mockSetScrollLocked.mockClear()
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

	it('calls setStickyIdentity on mount with provided sticky identity', () => {
		const sticky = <span>Bet title</span>
		render(<PageHeader stickyIdentity={sticky} />)
		expect(mockSetStickyIdentity).toHaveBeenCalledWith(sticky)
	})

	it('calls setStickyIdentity with null when unset', () => {
		render(<PageHeader />)
		expect(mockSetStickyIdentity).toHaveBeenCalledWith(null)
	})

	it('calls setStickyIdentity(null) on unmount', () => {
		const { unmount } = render(<PageHeader stickyIdentity={<span>Bet</span>} />)
		mockSetStickyIdentity.mockClear()
		unmount()
		expect(mockSetStickyIdentity).toHaveBeenCalledWith(null)
	})

	it('renders nothing visible', () => {
		const { container } = render(<PageHeader />)
		expect(container.firstChild).toBeNull()
	})

	it('calls setContentPush on mount with provided width', () => {
		render(<PageHeader contentPush="18rem" />)
		expect(mockSetContentPush).toHaveBeenCalledWith('18rem')
	})

	it('calls setContentPush with undefined when unset', () => {
		render(<PageHeader />)
		expect(mockSetContentPush).toHaveBeenCalledWith(undefined)
	})

	it('calls setContentPush(undefined) on unmount', () => {
		const { unmount } = render(<PageHeader contentPush="18rem" />)
		mockSetContentPush.mockClear()
		unmount()
		expect(mockSetContentPush).toHaveBeenCalledWith(undefined)
	})

	it('calls setScrollLocked on mount with the provided value', () => {
		render(<PageHeader scrollLocked />)
		expect(mockSetScrollLocked).toHaveBeenCalledWith(true)
	})

	it('calls setScrollLocked with false when unset', () => {
		render(<PageHeader />)
		expect(mockSetScrollLocked).toHaveBeenCalledWith(false)
	})

	it('calls setScrollLocked(false) on unmount', () => {
		const { unmount } = render(<PageHeader scrollLocked />)
		mockSetScrollLocked.mockClear()
		unmount()
		expect(mockSetScrollLocked).toHaveBeenCalledWith(false)
	})
})
