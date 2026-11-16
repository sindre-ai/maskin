import { PersonDetailView } from '@/components/people/person-detail-view'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const navigateMock = vi.fn()
const updateActorMutate = vi.fn()
const removeMutate = vi.fn()
const actorQuery = vi.hoisted(() => ({
	value: { data: undefined, isError: false, refetch: vi.fn() } as Record<string, unknown>,
}))
const membersMock = vi.hoisted(() => ({ data: [] as unknown[] }))
const objectsMock = vi.hoisted(() => ({ data: [] as unknown[], total: 0 }))
const storedActor = vi.hoisted(() => ({ id: 'me' }))

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActor: () => actorQuery.value,
	useUpdateActor: () => ({ mutate: updateActorMutate, isPending: false }),
}))
vi.mock('@/hooks/use-workspaces', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-workspaces')>()),
	useWorkspaceMembers: () => ({ data: membersMock.data }),
	useUpdateWorkspaceMemberRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRemoveWorkspaceMember: () => ({
		mutate: removeMutate,
		reset: vi.fn(),
		isPending: false,
		error: null,
	}),
}))
vi.mock('@/hooks/use-objects', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-objects')>()),
	useObjects: () => ({ data: objectsMock.data, isLoading: false }),
	useObjectFacets: () => ({ data: { total: objectsMock.total } }),
}))
vi.mock('@/lib/auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/auth')>()),
	getStoredActor: () => storedActor,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('@tanstack/react-router')>()),
	useNavigate: () => navigateMock,
	Link: ({ children }: { children: React.ReactNode }) => <a href="/x">{children}</a>,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ANNA = buildActorResponse({
	id: 'anna',
	name: 'Anna Berg',
	email: 'anna@example.com',
	description: 'Owns onboarding',
})

function renderPage(actorId: string, workspace = {}) {
	return render(<PersonDetailView actorId={actorId} />, {
		wrapper: createWorkspaceWrapper(workspace, { renderPageHeader: true }),
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	storedActor.id = 'me'
	actorQuery.value = { data: ANNA, isError: false, refetch: vi.fn() }
	membersMock.data = [
		{ actorId: 'me', name: 'Me Myself', type: 'human', role: 'admin', joinedAt: null },
		{ actorId: 'anna', name: 'Anna Berg', type: 'human', role: 'member', joinedAt: null },
	]
	objectsMock.data = []
	objectsMock.total = 0
})

describe('PersonDetailView', () => {
	it('shows who they are, their focus, empty work and the agent context', () => {
		renderPage('anna')
		expect(screen.getByRole('heading', { level: 1, name: 'Anna Berg' })).toBeInTheDocument()
		expect(screen.getByText('anna@example.com')).toBeInTheDocument()
		expect(screen.getByText('Member')).toBeInTheDocument()
		expect(screen.getByText('Owns onboarding')).toBeInTheDocument()
		expect(screen.getByText('Not driving any items yet.')).toBeInTheDocument()
		expect(screen.getByText('What agents know about Anna')).toBeInTheDocument()
		expect(screen.getByRole('combobox', { name: 'Role for Anna Berg' })).toHaveTextContent('member')
		expect(screen.getByRole('button', { name: 'Remove from workspace' })).toBeEnabled()
	})

	it('reads "No focus set yet" for an empty profile', () => {
		actorQuery.value = {
			data: buildActorResponse({ id: 'anna', name: 'Anna Berg', description: null }),
			isError: false,
			refetch: vi.fn(),
		}
		renderPage('anna')
		expect(screen.getByText('No focus set yet')).toBeInTheDocument()
	})

	it('opens New chat with the person picked when Message is pressed', async () => {
		renderPage('anna', { id: 'ws-1' })
		await userEvent.click(screen.getByRole('button', { name: 'Message' }))
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId: 'ws-1' },
			search: { agentId: 'anna', agentName: 'Anna Berg' },
		})
	})

	it('saves an edited focus line', async () => {
		renderPage('anna')
		await userEvent.click(screen.getByRole('button', { name: 'Edit focus' }))
		const input = screen.getByRole('textbox', { name: 'Focus' })
		await userEvent.clear(input)
		await userEvent.type(input, 'Owns billing{Enter}')
		expect(updateActorMutate).toHaveBeenCalledWith(
			{ id: 'anna', data: { description: 'Owns billing' } },
			expect.anything(),
		)
	})

	it('caps the works-on list at four rows behind Show all', async () => {
		objectsMock.data = ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({
			id: `o-${t}`,
			title: `Item ${t}`,
			status: 'active',
		}))
		objectsMock.total = 6
		renderPage('anna')
		expect(screen.queryByText('Item E')).toBeNull()
		await userEvent.click(screen.getByRole('button', { name: 'Show all 6' }))
		expect(screen.getByText('Item F')).toBeInTheDocument()
	})

	it('on your own page shows a You chip, no Message and Leave workspace', () => {
		storedActor.id = 'anna'
		renderPage('anna')
		expect(screen.getByText('You')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Message' })).toBeNull()
		expect(screen.queryByRole('combobox', { name: /Role for/ })).toBeNull()
		expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument()
	})

	it('blocks removing the billing owner and hides their role select', () => {
		membersMock.data = [
			{ actorId: 'anna', name: 'Anna Berg', type: 'human', role: 'owner', joinedAt: null },
		]
		renderPage('anna', { billingOwnerId: 'anna' })
		expect(screen.queryByRole('combobox', { name: /Role for/ })).toBeNull()
		expect(screen.getByRole('button', { name: 'Remove from workspace' })).toBeDisabled()
		expect(screen.getByText(/is the billing owner for this workspace/)).toBeInTheDocument()
	})

	it('confirms a removal in place before it calls the server', async () => {
		renderPage('anna')
		await userEvent.click(screen.getByRole('button', { name: 'Remove from workspace' }))
		expect(removeMutate).not.toHaveBeenCalled()
		await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
		expect(removeMutate).toHaveBeenCalledWith('anna', expect.anything())
	})

	it('disables Message, Edit and removal for a read-only viewer', () => {
		renderPage('anna', { role: 'viewer' })
		expect(screen.getByRole('button', { name: 'Message' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Remove from workspace' })).toBeDisabled()
	})

	it('shows a retry card when the person cannot be loaded', async () => {
		const refetch = vi.fn()
		actorQuery.value = { data: undefined, isError: true, refetch }
		renderPage('anna')
		expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this person")
		await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
		expect(refetch).toHaveBeenCalled()
		expect(screen.getByRole('link', { name: 'Back to members' })).toBeInTheDocument()
	})

	it('shows a skeleton while loading, with no Message button', () => {
		actorQuery.value = { data: undefined, isError: false, refetch: vi.fn() }
		renderPage('anna')
		expect(screen.queryByRole('button', { name: 'Message' })).toBeNull()
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
	})
})
