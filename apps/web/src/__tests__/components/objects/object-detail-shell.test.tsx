import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import type { MemberResponse } from '@/lib/api'
import { PageHeaderProvider, usePageHeader } from '@/lib/page-header-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { buildObjectResponse } from '../../factories'

const mockGetStoredActor = vi.fn()
const mockUseActors = vi.fn()

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockGetStoredActor(),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

const viewport = { isMobile: false, isTouch: false }
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => viewport.isMobile,
	useIsTouchViewport: () => viewport.isTouch,
}))

const members: MemberResponse[] = [
	{ actorId: 'a-1', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
]

// PageHeader only registers its actions into context; the app shell renders
// them. This harness mirrors the shell by rendering the registered slot next
// to the page so the overflow menu's wiring (Delete → confirm dialog) is
// exercised end-to-end.
function HeaderActions() {
	const { actions } = usePageHeader()
	return <>{actions}</>
}

function makeWrapper() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<PageHeaderProvider>
				<HeaderActions />
				{children}
			</PageHeaderProvider>
		</QueryClientProvider>
	)
}

const base = {
	workspaceId: 'ws-1',
	statuses: ['active', 'archived'],
	members,
	onStatusChange: vi.fn(),
	onDriverChange: vi.fn(),
	onDelete: vi.fn(),
	isDeleting: false,
}

function renderShell(object = buildObjectResponse(), overrides = {}) {
	return render(<ObjectDetailShell object={object} {...base} {...overrides} />, {
		wrapper: makeWrapper(),
	})
}

describe('ObjectDetailShell', () => {
	beforeEach(() => {
		mockGetStoredActor.mockReturnValue({ id: 'actor-1', name: 'Alice', type: 'human' })
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('renders the header, the ask banner and the answer composer', () => {
		const object = buildObjectResponse({
			title: 'Ship object detail',
			metadata: { _ask_title: 'Which option wins?', _ask_sub: 'A or B?' },
		})
		renderShell(object)

		expect(
			screen.getByRole('heading', { level: 1, name: 'Ship object detail' }),
		).toBeInTheDocument()
		expect(screen.getByText('Which option wins?')).toBeInTheDocument()
		expect(screen.getByText('A or B?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /answer it/i })).toBeInTheDocument()
		expect(screen.getByPlaceholderText(/write a comment/i)).toBeInTheDocument()
	})

	it('moves focus to the answer control when Answer it is clicked', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ metadata: { _ask_title: 'Question?' } })
		renderShell(object)

		await user.click(screen.getByRole('button', { name: /answer it/i }))

		expect(screen.getByPlaceholderText(/write a comment/i)).toHaveFocus()
	})

	it('hides the ask banner when the object has no open question', () => {
		const object = buildObjectResponse({ title: 'Plain object' })
		renderShell(object)

		expect(screen.queryByRole('button', { name: /answer it/i })).not.toBeInTheDocument()
		expect(screen.getByRole('heading', { level: 1, name: 'Plain object' })).toBeInTheDocument()
	})

	it('opens the delete confirmation from the overflow menu and fires onDelete', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onDelete = vi.fn()
		const object = buildObjectResponse({ type: 'bet', title: 'Doomed' })
		renderShell(object, { onDelete })

		await user.click(screen.getByRole('button', { name: /more actions/i }))
		await user.click(screen.getByRole('menuitem', { name: /delete/i }))

		expect(screen.getByRole('heading', { name: 'Delete this bet?' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Delete' }))
		expect(onDelete).toHaveBeenCalledTimes(1)
	})
})
