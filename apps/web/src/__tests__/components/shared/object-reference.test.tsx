import { ObjectReference } from '@/components/shared/object-reference'
import { render, screen, waitFor } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			get: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

describe('ObjectReference', () => {
	beforeEach(() => {
		vi.mocked(api.objects.get).mockReset()
	})

	it('renders pre-fetched object without fetching', () => {
		const obj = buildObjectResponse({
			id: 'obj-1',
			title: 'My Bet',
			type: 'bet',
			status: 'active',
		})

		render(<ObjectReference objectId={obj.id} workspaceId="ws-1" object={obj} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('My Bet')).toBeInTheDocument()
		expect(screen.getByText('bet')).toBeInTheDocument()
		expect(screen.getByText('active')).toBeInTheDocument()
		expect(api.objects.get).not.toHaveBeenCalled()
	})

	it('renders skeleton while loading', () => {
		vi.mocked(api.objects.get).mockReturnValue(new Promise(() => {}))

		const { container } = render(<ObjectReference objectId="obj-loading" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
	})

	it('fetches and renders the object once resolved', async () => {
		vi.mocked(api.objects.get).mockResolvedValue(
			buildObjectResponse({
				id: 'obj-fetched',
				title: 'Fetched Task',
				type: 'task',
				status: 'in_progress',
			}),
		)

		render(<ObjectReference objectId="obj-fetched" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() => {
			expect(screen.getByText('Fetched Task')).toBeInTheDocument()
		})
		expect(screen.getByText('task')).toBeInTheDocument()
		expect(screen.getByText('in progress')).toBeInTheDocument()
	})

	it('renders deleted-object placeholder when fetch fails', async () => {
		vi.mocked(api.objects.get).mockRejectedValue(new Error('not found'))

		render(<ObjectReference objectId="obj-missing" workspaceId="ws-1" />, {
			wrapper: TestWrapper,
		})

		await waitFor(() => {
			expect(screen.getByText('deleted object')).toBeInTheDocument()
		})
	})

	it('shows "Untitled" when object has no title', () => {
		const obj = buildObjectResponse({ id: 'obj-2', title: null, type: 'insight' })

		render(<ObjectReference objectId={obj.id} workspaceId="ws-1" object={obj} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('hides type badge when showType=false', () => {
		const obj = buildObjectResponse({ id: 'obj-3', title: 'A', type: 'insight' })

		render(<ObjectReference objectId={obj.id} workspaceId="ws-1" object={obj} showType={false} />, {
			wrapper: TestWrapper,
		})

		expect(screen.queryByText('insight')).not.toBeInTheDocument()
	})

	it('hides status badge when showStatus=false', () => {
		const obj = buildObjectResponse({
			id: 'obj-4',
			title: 'B',
			type: 'bet',
			status: 'active',
		})

		render(
			<ObjectReference objectId={obj.id} workspaceId="ws-1" object={obj} showStatus={false} />,
			{ wrapper: TestWrapper },
		)

		expect(screen.queryByText('active')).not.toBeInTheDocument()
	})

	it('navigates to canonical object route', () => {
		const obj = buildObjectResponse({ id: 'obj-5', title: 'Linkable', type: 'task' })

		render(<ObjectReference objectId={obj.id} workspaceId="ws-1" object={obj} />, {
			wrapper: TestWrapper,
		})

		const link = screen.getByRole('link')
		expect(link).toHaveAttribute('href', '/$workspaceId/objects/$objectId')
	})
})
