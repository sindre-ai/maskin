import { ObjectDetailHeader } from '@/components/objects/object-detail-header'
import type { MemberResponse } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
}))

const members: MemberResponse[] = [
	{ actorId: 'a-1', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
	{ actorId: 'a-2', role: 'member', joinedAt: null, name: 'Bob', type: 'agent' },
]

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
}

const baseProps = {
	workspaceId: 'ws-1',
	statuses: ['proposed', 'active', 'done'],
	members,
	onStatusChange: vi.fn(),
	onDriverChange: vi.fn(),
	onDeleteRequest: vi.fn(),
}

describe('ObjectDetailHeader', () => {
	it('renders breadcrumb with Objects link and object title', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectDetailHeader {...baseProps} object={object} />, { wrapper: makeWrapper() })
		expect(screen.getByRole('link', { name: 'Objects' })).toHaveAttribute('href')
		// Title appears both in the breadcrumb page crumb and the page h1
		expect(screen.getAllByText('My Bet').length).toBeGreaterThan(0)
		expect(screen.getByRole('heading', { level: 1, name: 'My Bet' })).toBeInTheDocument()
	})

	it('renders type badge, status trigger, and driver picker above the title', () => {
		const object = buildObjectResponse({ type: 'bet', status: 'active' })
		render(<ObjectDetailHeader {...baseProps} object={object} />, { wrapper: makeWrapper() })

		expect(screen.getByText('bet')).toBeInTheDocument()
		expect(screen.getByText('active')).toBeInTheDocument()
		expect(screen.getByText('Driver: Unassigned')).toBeInTheDocument()
	})

	it('renders the h1 title as static text (not an editable textarea)', () => {
		const object = buildObjectResponse({ title: 'Static Title' })
		render(<ObjectDetailHeader {...baseProps} object={object} />, { wrapper: makeWrapper() })
		expect(screen.getByRole('heading', { name: 'Static Title' })).toBeInTheDocument()
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('status dropdown offers the workspace statuses as checked options', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ status: 'active' })
		render(<ObjectDetailHeader {...baseProps} object={object} />, { wrapper: makeWrapper() })

		await user.click(screen.getByText('active'))
		const items = await screen.findAllByRole('option')
		expect(items.map((el) => el.textContent)).toEqual(['proposed', 'active', 'done'])
	})

	it('driver picker lists workspace members plus unassigned', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailHeader {...baseProps} object={object} />, { wrapper: makeWrapper() })

		await user.click(screen.getByText('Driver: Unassigned'))
		const items = await screen.findAllByRole('option')
		const labels = items.map((el) => el.textContent ?? '')
		expect(labels.some((l) => l.includes('Unassigned'))).toBe(true)
		expect(labels.some((l) => l.includes('Alice'))).toBe(true)
		expect(labels.some((l) => l.includes('Bob'))).toBe(true)
	})

	it('overflow menu exposes archive and delete actions', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet' })
		const onDeleteRequest = vi.fn()
		const onArchiveRequest = vi.fn()
		render(
			<ObjectDetailHeader
				{...baseProps}
				object={object}
				onDeleteRequest={onDeleteRequest}
				onArchiveRequest={onArchiveRequest}
			/>,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /more actions/i }))
		expect(await screen.findByRole('menuitem', { name: /archive/i })).toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
	})
})
