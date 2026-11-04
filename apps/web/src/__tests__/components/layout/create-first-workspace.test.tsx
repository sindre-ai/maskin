import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const navigate = vi.fn()
const logout = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}))

vi.mock('@/hooks/use-auth', () => ({
	useAuth: () => ({ logout }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: { ...actual.api, workspaces: { ...actual.api.workspaces, create: vi.fn() } },
	}
})

import { CreateFirstWorkspace } from '@/components/layout/create-first-workspace'
import { ApiError, api } from '@/lib/api'

function renderScreen() {
	return render(<CreateFirstWorkspace />, { wrapper: TestWrapper })
}

describe('CreateFirstWorkspace', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the heading and keeps create disabled until a name is typed', async () => {
		renderScreen()
		expect(screen.getByRole('heading', { name: 'Create your first workspace' })).toBeInTheDocument()
		const button = screen.getByRole('button', { name: 'Create workspace' })
		expect(button).toBeDisabled()
		await userEvent.type(screen.getByLabelText('Workspace name'), '  ')
		expect(button).toBeDisabled()
	})

	it('creates the workspace with the trimmed name and navigates into it', async () => {
		vi.mocked(api.workspaces.create).mockResolvedValue({ id: 'ws-new', name: 'Acme' } as never)
		renderScreen()
		await userEvent.type(screen.getByLabelText('Workspace name'), '  Acme ')
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith({
				to: '/$workspaceId',
				params: { workspaceId: 'ws-new' },
			}),
		)
		expect(vi.mocked(api.workspaces.create).mock.calls[0][0]).toEqual({ name: 'Acme' })
	})

	it('shows an error and does not navigate when creation fails', async () => {
		vi.mocked(api.workspaces.create).mockRejectedValue(new Error('boom'))
		renderScreen()
		await userEvent.type(screen.getByLabelText('Workspace name'), 'Acme')
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
		expect(await screen.findByText(/Couldn't create the workspace/)).toBeInTheDocument()
		expect(navigate).not.toHaveBeenCalled()
	})

	it('names the plan limit when the ownership cap rejects the create', async () => {
		const err = new ApiError(403, 'You own the maximum number of workspaces.')
		err.code = 'OWNERSHIP_CAP_EXCEEDED'
		vi.mocked(api.workspaces.create).mockRejectedValue(err)
		renderScreen()
		await userEvent.type(screen.getByLabelText('Workspace name'), 'Acme')
		await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
		expect(await screen.findByText(/Upgrade your plan/)).toBeInTheDocument()
	})

	it('signs out', async () => {
		renderScreen()
		await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
		expect(logout).toHaveBeenCalledTimes(1)
	})
})
