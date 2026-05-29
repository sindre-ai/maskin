import { ObjectDocument } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'
import { buildObjectResponse, buildWorkspaceWithRole } from '../../factories'

const mutateMock = vi.fn()
const trackEventMock = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/analytics', () => ({
	trackEvent: (...args: unknown[]) => trackEventMock(...args),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: buildWorkspaceWithRole() }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: () => ({ data: undefined }),
	useUpdateObject: () => ({ mutate: vi.fn() }),
	useDeleteObject: () => ({ mutate: mutateMock, isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => null,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => null,
}))

vi.mock('@/components/shared/subscribe-toggle', () => ({
	SubscribeToggle: () => null,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => null,
}))

vi.mock('@/components/objects/linked-objects', () => ({
	LinkedObjects: () => null,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => null,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))

beforeEach(() => {
	trackEventMock.mockClear()
	mutateMock.mockClear()
})

async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole('button', { name: /more actions/i }))
	await user.click(screen.getByRole('menuitem', { name: /delete/i }))
}

describe('ObjectDocument delete-confirmation instrumentation', () => {
	// First-test telemetry for the auxiliary action menu bet — one week of
	// `delete_confirmation_cancelled` events tells us whether misclicked
	// deletes are real or only theoretical.

	it('fires delete_confirmation_shown when the trash icon is clicked', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-a', type: 'bet', title: 'A bet' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await openDeleteDialog(user)

		expect(trackEventMock).toHaveBeenCalledWith('delete_confirmation_shown', {
			object_type: 'bet',
			object_id: 'obj-a',
		})
	})

	it('fires delete_confirmation_cancelled when the dialog is dismissed via Cancel', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-b', type: 'task', title: 'A task' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await openDeleteDialog(user)
		trackEventMock.mockClear()
		await user.click(screen.getByRole('button', { name: /cancel/i }))

		expect(trackEventMock).toHaveBeenCalledWith('delete_confirmation_cancelled', {
			object_type: 'task',
			object_id: 'obj-b',
		})
	})

	it('does not fire delete_confirmation_cancelled when the user confirms', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-c', type: 'insight', title: 'An insight' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await openDeleteDialog(user)
		trackEventMock.mockClear()
		await user.click(screen.getByRole('button', { name: /^delete$/i }))

		expect(mutateMock).toHaveBeenCalledTimes(1)
		expect(trackEventMock).not.toHaveBeenCalledWith(
			'delete_confirmation_cancelled',
			expect.anything(),
		)
	})

	it('fires delete_confirmation_cancelled when the user cancels after a failed delete', async () => {
		// Without the onError reset, confirmedDeleteRef stays true after a
		// failed mutation and the subsequent cancel is silently dropped.
		mutateMock.mockImplementation((_id, options) => {
			options?.onError?.(new Error('boom'))
		})
		const user = userEvent.setup()
		const object = buildObjectResponse({ id: 'obj-d', type: 'bet', title: 'A bet' })
		render(<ObjectDocument object={object} />, { wrapper: TestWrapper })

		await openDeleteDialog(user)
		await user.click(screen.getByRole('button', { name: /^delete$/i }))
		trackEventMock.mockClear()
		await user.click(screen.getByRole('button', { name: /cancel/i }))

		expect(trackEventMock).toHaveBeenCalledWith('delete_confirmation_cancelled', {
			object_type: 'bet',
			object_id: 'obj-d',
		})
	})
})
