import { RouteError } from '@/components/shared/route-error'
import * as sentryLib from '@/lib/sentry'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockInvalidate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({ invalidate: mockInvalidate }),
}))

vi.mock('@/lib/sentry', () => ({
	captureException: vi.fn(),
}))

const mockCaptureException = vi.mocked(sentryLib.captureException)

afterEach(() => {
	mockCaptureException.mockClear()
})

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

	it('reports the error to Sentry on mount', () => {
		const error = new Error('test failure')
		render(<RouteError error={error} />)
		expect(mockCaptureException).toHaveBeenCalledOnce()
		expect(mockCaptureException).toHaveBeenCalledWith(error)
	})
})
