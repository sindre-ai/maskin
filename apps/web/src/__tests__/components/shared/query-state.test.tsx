import { EmptyState } from '@/components/shared/empty-state'
import { NotFoundState, QueryState, QueryStateError } from '@/components/shared/query-state'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({ invalidate: vi.fn() }),
}))

vi.mock('@/lib/sentry', () => ({
	captureException: vi.fn(),
}))

describe('QueryState', () => {
	it('renders loading skeleton by default while the query is loading', () => {
		const { container } = render(
			<QueryState query={{ data: undefined, isLoading: true, isError: false }}>
				{(data: unknown[]) => <div data-testid="ready">{data.length}</div>}
			</QueryState>,
		)
		expect(screen.queryByTestId('ready')).not.toBeInTheDocument()
		expect(container.querySelector('.animate-pulse')).toBeTruthy()
	})

	it('renders the provided loading node when supplied', () => {
		render(
			<QueryState
				query={{ data: undefined, isLoading: true, isError: false }}
				loading={<div>Custom loading</div>}
			>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(screen.getByText('Custom loading')).toBeInTheDocument()
	})

	it('renders inline error with a retry button on error', async () => {
		const refetch = vi.fn()
		const user = userEvent.setup()
		render(
			<QueryState
				query={{
					data: undefined,
					isLoading: false,
					isError: true,
					error: new Error('boom'),
					refetch,
				}}
				errorTitle="Couldn't load widgets"
			>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(screen.getByText("Couldn't load widgets")).toBeInTheDocument()
		expect(screen.getByText('boom')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /try again/i }))
		expect(refetch).toHaveBeenCalledOnce()
	})

	it('renders empty node when data is an empty array and empty prop is provided', () => {
		render(
			<QueryState
				query={{ data: [] as string[], isLoading: false, isError: false }}
				empty={<EmptyState title="Nothing yet" />}
			>
				{() => <div>Should not render</div>}
			</QueryState>,
		)
		expect(screen.getByText('Nothing yet')).toBeInTheDocument()
		expect(screen.queryByText('Should not render')).not.toBeInTheDocument()
	})

	it('renders children when data is present and non-empty', () => {
		render(
			<QueryState query={{ data: ['a', 'b'], isLoading: false, isError: false }}>
				{(items) => <div>Loaded: {items.join(',')}</div>}
			</QueryState>,
		)
		expect(screen.getByText('Loaded: a,b')).toBeInTheDocument()
	})

	it('applies custom isEmpty predicate', () => {
		render(
			<QueryState
				query={{ data: { count: 0 }, isLoading: false, isError: false }}
				empty={<div>Empty count</div>}
				isEmpty={(d) => d.count === 0}
			>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(screen.getByText('Empty count')).toBeInTheDocument()
	})

	it('prefers isPending when isLoading is not passed (e.g. useMutation-style hooks)', () => {
		const { container } = render(
			<QueryState query={{ data: undefined, isPending: true, isError: false }}>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(container.querySelector('.animate-pulse')).toBeTruthy()
	})
	it('keeps cached content and warns when a refetch fails', async () => {
		// A background refetch / SSE invalidation / reconnect failure must never
		// render a stale snapshot as if it were fresh.
		const refetch = vi.fn()
		const user = userEvent.setup()
		render(
			<QueryState
				query={{
					data: ['a', 'b'],
					isLoading: false,
					isError: true,
					error: new Error('refetch boom'),
					refetch,
				}}
			>
				{(data: unknown[]) => <div data-testid="ready">{data.length}</div>}
			</QueryState>,
		)
		expect(screen.getByTestId('ready')).toHaveTextContent('2')
		expect(screen.getByRole('status')).toHaveTextContent(/couldn.t refresh/i)
		await user.click(screen.getByRole('button', { name: /try again/i }))
		expect(refetch).toHaveBeenCalledOnce()
	})

	it('shows no stale notice when the query is healthy', () => {
		render(
			<QueryState query={{ data: ['a'], isLoading: false, isError: false }}>
				{(data: unknown[]) => <div data-testid="ready">{data.length}</div>}
			</QueryState>,
		)
		expect(screen.queryByRole('status')).not.toBeInTheDocument()
	})

	it('resolves a settled-undefined query to the empty state, not an endless skeleton', () => {
		const { container } = render(
			<QueryState query={{ data: undefined, isLoading: false, isError: false }}>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(container.querySelector('.animate-pulse')).toBeNull()
		expect(screen.getByText('Not found')).toBeInTheDocument()
	})

	it('prefers the caller empty node for a settled-undefined query', () => {
		render(
			<QueryState
				query={{ data: undefined, isLoading: false, isError: false }}
				empty={<EmptyState title="No widgets" />}
			>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(screen.getByText('No widgets')).toBeInTheDocument()
	})

	it('keeps the skeleton for a disabled query that has not fetched yet', () => {
		const { container } = render(
			<QueryState
				query={{ data: undefined, isLoading: false, isError: false, fetchStatus: 'fetching' }}
			>
				{() => <div>Ready</div>}
			</QueryState>,
		)
		expect(container.querySelector('.animate-pulse')).toBeTruthy()
	})
})

describe('QueryStateError', () => {
	it('renders title and error message', () => {
		render(<QueryStateError title="Couldn't load" error={new Error('nope')} />)
		expect(screen.getByText("Couldn't load")).toBeInTheDocument()
		expect(screen.getByText('nope')).toBeInTheDocument()
	})

	it('calls onRetry when Try again is clicked', async () => {
		const user = userEvent.setup()
		const onRetry = vi.fn()
		render(<QueryStateError title="Oops" error={new Error('x')} onRetry={onRetry} />)
		await user.click(screen.getByRole('button', { name: /try again/i }))
		expect(onRetry).toHaveBeenCalledOnce()
	})

	it('falls back to a generic error message when error is null', () => {
		render(<QueryStateError title="Oops" error={null} />)
		expect(screen.getByText('Unknown error')).toBeInTheDocument()
	})
})

describe('NotFoundState', () => {
	it('renders the default not-found message', () => {
		render(<NotFoundState />)
		expect(screen.getByText('Not found')).toBeInTheDocument()
	})

	it('renders custom title and description', () => {
		render(<NotFoundState title="No such thing" description="Really gone" />)
		expect(screen.getByText('No such thing')).toBeInTheDocument()
		expect(screen.getByText('Really gone')).toBeInTheDocument()
	})
})
