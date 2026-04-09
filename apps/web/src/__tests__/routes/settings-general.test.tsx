import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

const mockMutate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({ name: 'My Workspace' }),
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: mockMutate, isPending: false }),
}))

vi.mock('@/lib/theme', () => ({
	useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => [],
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => [],
}))

vi.mock('@maskin/module-sdk', () => ({
	getAllWebModules: () => [],
	getWebModule: () => null,
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/index'

const GeneralPage = (Route as unknown as { component: React.FC }).component

describe('GeneralPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders workspace name input with current value', () => {
		render(<GeneralPage />)
		const input = screen.getByDisplayValue('My Workspace')
		expect(input).toBeInTheDocument()
	})

	it('disables Save button when name matches current workspace name', () => {
		render(<GeneralPage />)
		const saveButtons = screen.getAllByRole('button', { name: 'Save' })
		expect(saveButtons[0]).toBeDisabled()
	})

	it('enables Save button when name is changed', async () => {
		const user = userEvent.setup()
		render(<GeneralPage />)
		const input = screen.getByDisplayValue('My Workspace')
		await user.clear(input)
		await user.type(input, 'New Name')
		const saveButtons = screen.getAllByRole('button', { name: 'Save' })
		expect(saveButtons[0]).toBeEnabled()
	})

	it('calls updateWorkspace.mutate with new name on save', async () => {
		const user = userEvent.setup()
		render(<GeneralPage />)
		const input = screen.getByDisplayValue('My Workspace')
		await user.clear(input)
		await user.type(input, 'New Name')
		const saveButtons = screen.getAllByRole('button', { name: 'Save' })
		await user.click(saveButtons[0])
		expect(mockMutate).toHaveBeenCalledWith({ name: 'New Name' })
	})

	it('renders theme picker with light/dark/system options', () => {
		render(<GeneralPage />)
		expect(screen.getByText('Light')).toBeInTheDocument()
		expect(screen.getByText('Dark')).toBeInTheDocument()
		expect(screen.getByText('System')).toBeInTheDocument()
	})

	it('renders extensions section', () => {
		render(<GeneralPage />)
		expect(screen.getByText('Extensions')).toBeInTheDocument()
	})
})
