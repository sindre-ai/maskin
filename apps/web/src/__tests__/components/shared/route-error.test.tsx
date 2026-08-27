import { RouteError } from '@/components/shared/route-error'
import * as faroLib from '@/lib/faro'
import * as sentryLib from '@/lib/sentry'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockInvalidate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({ invalidate: mockInvalidate }),
}))

vi.mock('@/lib/sentry', () => ({
	captureException: vi.fn(),
}))

vi.mock('@/lib/faro', () => ({
	pushFaroError: vi.fn(),
}))

const mockCaptureException = vi.mocked(sentryLib.captureException)
const mockPushFaroError = vi.mocked(faroLib.pushFaroError)

afterEach(() => {
	mockCaptureException.mockClear()
	mockPushFaroError.mockClear()
	mockInvalidate.mockClear()
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

	// React catches render errors before window.onerror, so Faro's
	// ErrorsInstrumentation cannot see them — this boundary is the only place
	// they can be reported from. Without it, Sentry would see a whole error
	// class that Faro does not, and the parallel-run comparison would be
	// measuring the wiring rather than the SDKs.
	it('reports the error to Faro on mount, so both SDKs see the same errors', () => {
		const error = new Error('test failure')
		render(<RouteError error={error} />)
		expect(mockPushFaroError).toHaveBeenCalledOnce()
		expect(mockPushFaroError).toHaveBeenCalledWith(error)
	})

	it('calls onRetry when provided instead of router.invalidate', async () => {
		const user = userEvent.setup()
		const onRetry = vi.fn()
		render(<RouteError error={new Error('x')} onRetry={onRetry} />)
		await user.click(screen.getByRole('button', { name: /try again/i }))
		expect(onRetry).toHaveBeenCalledOnce()
		expect(mockInvalidate).not.toHaveBeenCalled()
	})

	it('renders custom title in the default variant', () => {
		render(<RouteError error={new Error('x')} title="Custom title" />)
		expect(screen.getByText('Custom title')).toBeInTheDocument()
	})

	it('renders the compact variant without the min-h-[50vh] wrapper', () => {
		const { container } = render(<RouteError error={new Error('x')} compact title="Inline" />)
		expect(screen.getByText('Inline')).toBeInTheDocument()
		expect(container.querySelector('.min-h-\\[50vh\\]')).toBeNull()
	})

	it('does not re-report the same error instance when the component re-renders', () => {
		const error = new Error('same instance')
		const { rerender } = render(<RouteError error={error} />)
		rerender(<RouteError error={error} title="Different title" />)
		rerender(<RouteError error={error} title="Different again" />)
		expect(mockCaptureException).toHaveBeenCalledOnce()
	})

	it('reports the new error when a distinct error instance is passed on re-render', () => {
		const first = new Error('first')
		const second = new Error('second')
		const { rerender } = render(<RouteError error={first} />)
		rerender(<RouteError error={second} />)
		expect(mockCaptureException).toHaveBeenCalledTimes(2)
		expect(mockCaptureException).toHaveBeenNthCalledWith(1, first)
		expect(mockCaptureException).toHaveBeenNthCalledWith(2, second)
		expect(mockPushFaroError).toHaveBeenCalledTimes(2)
		expect(mockPushFaroError).toHaveBeenNthCalledWith(1, first)
		expect(mockPushFaroError).toHaveBeenNthCalledWith(2, second)
	})

	describe('compact variant', () => {
		it('does not report to Sentry when unmounted before the delay elapses', () => {
			vi.useFakeTimers()
			try {
				const { unmount } = render(<RouteError error={new Error('transient')} compact />)
				expect(mockCaptureException).not.toHaveBeenCalled()
				act(() => {
					vi.advanceTimersByTime(500)
				})
				unmount()
				act(() => {
					vi.advanceTimersByTime(10000)
				})
				expect(mockCaptureException).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it('reports to Sentry once the delay elapses while still mounted', () => {
			vi.useFakeTimers()
			try {
				const error = new Error('persistent')
				render(<RouteError error={error} compact />)
				expect(mockCaptureException).not.toHaveBeenCalled()
				act(() => {
					vi.advanceTimersByTime(3000)
				})
				expect(mockCaptureException).toHaveBeenCalledOnce()
				expect(mockCaptureException).toHaveBeenCalledWith(error)
				expect(mockPushFaroError).toHaveBeenCalledOnce()
				expect(mockPushFaroError).toHaveBeenCalledWith(error)
			} finally {
				vi.useRealTimers()
			}
		})

		it('does not re-report the same error instance across re-renders', () => {
			vi.useFakeTimers()
			try {
				const error = new Error('same')
				const { rerender } = render(<RouteError error={error} compact />)
				act(() => {
					vi.advanceTimersByTime(3000)
				})
				expect(mockCaptureException).toHaveBeenCalledOnce()
				rerender(<RouteError error={error} compact title="rerender" />)
				act(() => {
					vi.advanceTimersByTime(10000)
				})
				expect(mockCaptureException).toHaveBeenCalledOnce()
			} finally {
				vi.useRealTimers()
			}
		})
	})
})
