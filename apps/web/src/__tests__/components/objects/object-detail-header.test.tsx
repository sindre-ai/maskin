import {
	ObjectDetailBarActions,
	ObjectDetailIdentity,
} from '@/components/objects/object-detail-header'
import type { MemberResponse } from '@/lib/api'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const subscribeMock = vi.fn()
const unsubscribeMock = vi.fn()

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: subscribeMock, isPending: false }),
	useUnsubscribe: () => ({ mutate: unsubscribeMock, isPending: false }),
	useSubscribers: () => ({ data: { actors: [] } }),
}))

vi.mock('@/lib/auth', async () => {
	const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
	return {
		...actual,
		getStoredActor: vi.fn(() => ({ id: 'a1', name: 'Alice', type: 'human', email: null })),
	}
})

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

describe('ObjectDetailBarActions', () => {
	// The crumb is published to the shared nav's detail bar, which renders it
	// alongside this cluster — the cluster itself carries actions only.
	it('renders no breadcrumb of its own', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectDetailBarActions {...baseProps} object={object} />, { wrapper: makeWrapper() })
		expect(screen.queryByRole('link', { name: 'Objects' })).toBeNull()
		expect(screen.queryByText('My Bet')).toBeNull()
	})

	it('renders the properties toggle when the host wires it', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ title: 'My Bet' })
		const onTogglePropertiesRequest = vi.fn()
		render(
			<ObjectDetailBarActions
				{...baseProps}
				object={object}
				onTogglePropertiesRequest={onTogglePropertiesRequest}
				propertiesOpen={false}
			/>,
			{ wrapper: makeWrapper() },
		)
		const toggle = screen.getByRole('button', { name: 'Properties' })
		expect(toggle).toHaveAttribute('aria-expanded', 'false')
		await user.click(toggle)
		expect(onTogglePropertiesRequest).toHaveBeenCalledOnce()
	})

	it('omits the properties toggle when no handler is wired', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectDetailBarActions {...baseProps} object={object} />, { wrapper: makeWrapper() })
		expect(screen.queryByRole('button', { name: 'Properties' })).toBeNull()
	})

	// Subscription is no longer a header affordance: the v2 detail bar carries
	// only the drawer toggle and the ⋯ menu, and Subscribers moved into the
	// properties drawer (object-properties-sidebar).
})

describe('ObjectDetailIdentity', () => {
	const identityProps = {
		statuses: baseProps.statuses,
		members,
		onStatusChange: vi.fn(),
		onDriverChange: vi.fn(),
	}

	it('renders type badge, status chip, and driver chip above the title', () => {
		const object = buildObjectResponse({ type: 'bet', status: 'active' })
		render(<ObjectDetailIdentity {...identityProps} object={object} />, { wrapper: makeWrapper() })

		expect(screen.getByText('Bet')).toBeInTheDocument()
		expect(screen.getByText('active')).toBeInTheDocument()
		expect(screen.getByText('Driver')).toBeInTheDocument()
		expect(screen.getByText('Unassigned')).toBeInTheDocument()
	})

	it('renders a static h1 for read-only hosts that pass no onTitleChange', () => {
		const object = buildObjectResponse({ title: 'Static Title' })
		render(<ObjectDetailIdentity {...identityProps} object={object} />, { wrapper: makeWrapper() })
		expect(screen.getByRole('heading', { level: 1, name: 'Static Title' })).toBeInTheDocument()
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('renders an editable title and commits a rename on blur', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onTitleChange = vi.fn()
		const object = buildObjectResponse({ title: 'Old Title' })
		render(
			<ObjectDetailIdentity {...identityProps} object={object} onTitleChange={onTitleChange} />,
			{ wrapper: makeWrapper() },
		)

		const input = screen.getByRole('textbox', { name: 'Object title' })
		await user.clear(input)
		await user.type(input, 'New Title')
		await user.tab()

		expect(onTitleChange).toHaveBeenCalledWith('New Title')
	})

	it('does not commit when the title is blurred unchanged', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onTitleChange = vi.fn()
		const object = buildObjectResponse({ title: 'Unchanged' })
		render(
			<ObjectDetailIdentity {...identityProps} object={object} onTitleChange={onTitleChange} />,
			{ wrapper: makeWrapper() },
		)

		await user.click(screen.getByRole('textbox', { name: 'Object title' }))
		await user.tab()

		expect(onTitleChange).not.toHaveBeenCalled()
	})

	it('resets the title draft when the route swaps to a different object', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onTitleChange = vi.fn()
		const first = buildObjectResponse({ id: 'obj-a', title: 'First' })
		const second = buildObjectResponse({ id: 'obj-b', title: 'Second' })
		const { rerender } = render(
			<ObjectDetailIdentity {...identityProps} object={first} onTitleChange={onTitleChange} />,
			{ wrapper: makeWrapper() },
		)

		const input = screen.getByRole('textbox', { name: 'Object title' })
		await user.clear(input)
		await user.type(input, 'Edited but never blurred')

		rerender(
			<ObjectDetailIdentity {...identityProps} object={second} onTitleChange={onTitleChange} />,
		)

		expect(screen.getByRole('textbox', { name: 'Object title' })).toHaveValue('Second')
	})

	it('status dropdown offers the workspace statuses as checked options', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ status: 'active' })
		render(<ObjectDetailIdentity {...identityProps} object={object} />, { wrapper: makeWrapper() })

		await user.click(screen.getByText('active'))
		const items = await screen.findAllByRole('option')
		expect(items.map((el) => el.textContent)).toEqual(['proposed', 'active', 'done'])
	})

	it('driver picker lists workspace members plus unassigned', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailIdentity {...identityProps} object={object} />, { wrapper: makeWrapper() })

		await user.click(screen.getByText('Driver'))
		const items = await screen.findAllByRole('option')
		const labels = items.map((el) => el.textContent ?? '')
		expect(labels.some((l) => l.includes('Unassigned'))).toBe(true)
		expect(labels.some((l) => l.includes('Alice'))).toBe(true)
		expect(labels.some((l) => l.includes('Bob'))).toBe(true)
	})
})

describe('ObjectDetailBarActions overflow menu', () => {
	it('overflow menu exposes archive and delete actions', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const object = buildObjectResponse({ type: 'bet' })
		const onDeleteRequest = vi.fn()
		const onArchiveRequest = vi.fn()
		render(
			<ObjectDetailBarActions
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
