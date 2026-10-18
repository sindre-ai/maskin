import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUpdateActor = vi.fn()
const mockStoredActor = vi.fn()
const mockWorkspace = { current: buildWorkspaceWithRole({ isDefault: false }) }

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: mockWorkspace.current,
		workspaceId: mockWorkspace.current.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
	useWorkspaces: () => ({ data: [] }),
	removeDeletedWorkspaceQueries: vi.fn(),
	useWorkspaceDeletionPreview: () => ({ data: undefined, isLoading: false, isError: false }),
	useDeleteWorkspace: () => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useUpdateActor: () => ({ mutate: mockUpdateActor, isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockStoredActor(),
}))

vi.mock('@/lib/theme', () => ({
	useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/index'

const GeneralPage = Route.options.component as () => React.ReactElement

function renderPage() {
	return render(
		<TestWrapper>
			<GeneralPage />
		</TestWrapper>,
	)
}

const switchName = 'Make this my default workspace'

describe('Settings > General > Default workspace', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockStoredActor.mockReturnValue({ id: 'actor-1', name: 'Me', type: 'human', email: null })
		mockWorkspace.current = buildWorkspaceWithRole({ isDefault: false })
	})

	it('shows the switch off when this is not the default workspace', () => {
		renderPage()

		expect(screen.getByRole('heading', { name: 'DEFAULT WORKSPACE' })).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: switchName })).not.toBeChecked()
	})

	it('shows the switch on when this workspace is the default', () => {
		mockWorkspace.current = buildWorkspaceWithRole({ isDefault: true })
		renderPage()

		expect(screen.getByRole('switch', { name: switchName })).toBeChecked()
	})

	it('sets this workspace as the default on the signed-in actor', async () => {
		renderPage()

		await userEvent.setup().click(screen.getByRole('switch', { name: switchName }))

		const [payload] = mockUpdateActor.mock.calls[0]
		expect(payload).toEqual({
			id: 'actor-1',
			data: { default_workspace_id: mockWorkspace.current.id },
		})
	})

	it('clears the default when switched off', async () => {
		mockWorkspace.current = buildWorkspaceWithRole({ isDefault: true })
		renderPage()

		await userEvent.setup().click(screen.getByRole('switch', { name: switchName }))

		const [payload] = mockUpdateActor.mock.calls[0]
		expect(payload).toEqual({ id: 'actor-1', data: { default_workspace_id: null } })
	})

	it('disables the switch when there is no signed-in actor to save it on', () => {
		mockStoredActor.mockReturnValue(null)
		renderPage()

		expect(screen.getByRole('switch', { name: switchName })).toBeDisabled()
	})
})
