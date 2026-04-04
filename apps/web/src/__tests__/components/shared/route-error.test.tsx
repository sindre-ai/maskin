import { RouteError } from '@/components/shared/route-error'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockInvalidate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({ invalidate: mockInvalidate }),
}))

describe('RouteError', () => {
	it('renders "Something went wrong" heading', () => {
		render(<RouteError error={new Error('test failure')} />)
		expect(screen.getByText('Something went wrong')).toBeInTheDocument()
	})

	it('renders error message text', () => {
		render(<RouteError error={new Error('Connection refused')} />)
		expect(screen.getByText('Connection refused')).toBeInTheDocument()
	})

	it('calls router.invalidate on Try Again click', async () => {
		const user = userEvent.setup()
		render(<RouteError error={new Error('oops')} />)

		await user.click(screen.getByRole('button', { name: /try again/i }))
		expect(mockInvalidate).toHaveBeenCalledOnce()
	})
})
