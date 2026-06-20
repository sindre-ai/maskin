import { InlineObjectChip } from '@/components/shared/inline-object-chip'
import { ApiError } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			objects: {
				get: vi.fn(),
			},
		},
	}
})

import { api } from '@/lib/api'

describe('InlineObjectChip', () => {
	beforeEach(() => {
		vi.mocked(api.objects.get).mockReset()
	})

	it('renders a loading placeholder while fetching', () => {
		vi.mocked(api.objects.get).mockReturnValue(new Promise(() => {}))
		render(<InlineObjectChip objectId="obj-loading" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument()
	})

	it('renders title + deep-link when the object resolves', async () => {
		vi.mocked(api.objects.get).mockResolvedValue(
			buildObjectResponse({
				id: 'cf6545dc-74dd-4cba-ab27-16d808112bee',
				title: 'My Inline Bet',
				type: 'bet',
				status: 'active',
			}),
		)
		render(
			<InlineObjectChip objectId="cf6545dc-74dd-4cba-ab27-16d808112bee" workspaceId="ws-1" />,
			{ wrapper: TestWrapper },
		)
		await waitFor(() => {
			expect(screen.getByText('My Inline Bet')).toBeInTheDocument()
		})
		const link = screen.getByRole('link', { name: /My Inline Bet/i })
		expect(link.getAttribute('href')).toBe('/$workspaceId/objects/$objectId')
	})

	it('renders deleted-object placeholder when the fetch fails', async () => {
		vi.mocked(api.objects.get).mockRejectedValue(new Error('not found'))
		render(<InlineObjectChip objectId="obj-missing" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => {
			expect(screen.getByText('deleted object')).toBeInTheDocument()
		})
	})

	it('uses inline-only DOM (no divs) so it can mount inside a paragraph', async () => {
		vi.mocked(api.objects.get).mockResolvedValue(
			buildObjectResponse({ id: 'obj-1', title: 'In Place', type: 'task' }),
		)
		const { container } = render(<InlineObjectChip objectId="obj-1" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(screen.getByText('In Place')).toBeInTheDocument())
		// Any <div> rendered inside the chip would re-introduce the
		// <div>-inside-<p> hydration warning when the chip mounts inline.
		expect(container.querySelector('div')).toBeNull()
	})

	it('does not retry on 404, flips straight to the deleted placeholder', async () => {
		// Drive the QueryClient with TanStack's default-style retry behaviour
		// (retry enabled, no backoff). The chip itself opts out via `retry: false`,
		// so a 404 must short-circuit after a single network round-trip rather
		// than firing the 3× retry chain that the default useObject inherits.
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: true, retryDelay: 0, gcTime: 0 },
				mutations: { retry: false },
			},
		})
		const RetryWrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		)
		vi.mocked(api.objects.get).mockRejectedValue(new ApiError(404, 'object not found'))
		render(<InlineObjectChip objectId="obj-404" workspaceId="ws-1" />, {
			wrapper: RetryWrapper,
		})
		await waitFor(() => {
			expect(screen.getByText('deleted object')).toBeInTheDocument()
		})
		expect(vi.mocked(api.objects.get)).toHaveBeenCalledTimes(1)
	})

	it('falls back to "Untitled" when the object has no title', async () => {
		vi.mocked(api.objects.get).mockResolvedValue(
			buildObjectResponse({ id: 'obj-2', title: null, type: 'insight' }),
		)
		render(<InlineObjectChip objectId="obj-2" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(screen.getByText('Untitled')).toBeInTheDocument())
	})
})
