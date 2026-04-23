import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockUseWorkspaceSkills = vi.fn()
const mockUseWorkspaceSkill = vi.fn()
const mockCreateMutate = vi.fn()
const mockUpdateMutate = vi.fn()
const mockDeleteMutate = vi.fn()
const createPending = { value: false }
const updatePending = { value: false }
const deletePending = { value: false }

vi.mock('@/hooks/use-workspace-skills', () => ({
	useWorkspaceSkills: (...args: unknown[]) => mockUseWorkspaceSkills(...args),
	useWorkspaceSkill: (...args: unknown[]) => mockUseWorkspaceSkill(...args),
	useCreateWorkspaceSkill: () => ({ mutate: mockCreateMutate, isPending: createPending.value }),
	useUpdateWorkspaceSkill: () => ({ mutate: mockUpdateMutate, isPending: updatePending.value }),
	useDeleteWorkspaceSkill: () => ({ mutate: mockDeleteMutate, isPending: deletePending.value }),
}))

// Route is imported after the mocks so the component picks up the mocked hooks.
import { Route } from '@/routes/_authed/$workspaceId/settings/skills'

const SkillsPage = Route.options.component as () => React.ReactElement

function renderPage() {
	return render(
		<TestWrapper>
			<SkillsPage />
		</TestWrapper>,
	)
}

const buildSkill = (overrides: Record<string, unknown> = {}) => ({
	id: 'skill-1',
	workspaceId: 'ws-1',
	name: 'deploy',
	description: 'Deploy the service',
	storageKey: 'workspaces/ws-1/skills/deploy/SKILL.md',
	sizeBytes: 100,
	createdBy: 'actor-1',
	createdAt: '2026-04-23T00:00:00Z',
	updatedAt: '2026-04-23T00:00:00Z',
	...overrides,
})

describe('Settings > Skills', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		createPending.value = false
		updatePending.value = false
		deletePending.value = false
		mockUseWorkspaceSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseWorkspaceSkill.mockReturnValue({ data: null, isLoading: false })
		mockCreateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
		mockUpdateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
		mockDeleteMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
	})

	it('shows empty state when there are no skills', () => {
		renderPage()
		expect(screen.getByText('No skills yet')).toBeInTheDocument()
		expect(
			screen.getByText('Create a skill to share it with agents in this workspace.'),
		).toBeInTheDocument()
	})

	it('renders skills in the list', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildSkill({ id: 's1', name: 'deploy', description: 'Deploy the service' }),
				buildSkill({ id: 's2', name: 'review', description: 'Review a PR' }),
			],
			isLoading: false,
		})
		renderPage()
		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('Deploy the service')).toBeInTheDocument()
		expect(screen.getByText('review')).toBeInTheDocument()
		expect(screen.getByText('Review a PR')).toBeInTheDocument()
	})

	it('submits the create dialog and calls create mutation', async () => {
		const user = userEvent.setup()
		renderPage()

		// Open dialog via header button (not the empty-state one — both exist, pick the first).
		await user.click(screen.getAllByRole('button', { name: /Create skill/ })[0])

		expect(screen.getByRole('heading', { name: 'Create skill' })).toBeInTheDocument()

		const nameInput = screen.getByLabelText('Name')
		await user.type(nameInput, 'new-skill')

		const contentInput = screen.getByLabelText('SKILL.md')
		await user.clear(contentInput)
		await user.type(contentInput, 'body')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockCreateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockCreateMutate.mock.calls[0]
		expect(payload).toEqual({ name: 'new-skill', content: 'body' })
	})

	it('confirms deletion and calls delete mutation', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Delete/ }))

		expect(screen.getByRole('heading', { name: 'Delete skill' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Delete' }))

		await waitFor(() => expect(mockDeleteMutate).toHaveBeenCalledTimes(1))
		const [name] = mockDeleteMutate.mock.calls[0]
		expect(name).toBe('deploy')
	})
})
