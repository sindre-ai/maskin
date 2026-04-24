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
import {
	Route,
	deriveNameFromFileName,
	toSkillUpload,
	uniqueName,
} from '@/routes/_authed/$workspaceId/settings/skills'

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
	isValid: true,
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
			screen.getByText(
				"Create a skill, browse for SKILL.md files, or drag and drop them here. Files that don't match the SKILL.md format are still added so you can fix them.",
			),
		).toBeInTheDocument()
	})

	it('renders a warning icon for skills with invalid format', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'broken-skill', description: null, isValid: false })],
			isLoading: false,
		})
		renderPage()
		expect(screen.getByLabelText('Invalid SKILL.md format')).toBeInTheDocument()
		expect(
			screen.getByText("Won't be loaded by agents until the format is fixed"),
		).toBeInTheDocument()
	})

	it('allows renaming a skill via the edit dialog', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		mockUseWorkspaceSkill.mockReturnValue({
			data: { ...buildSkill({ name: 'deploy' }), content: 'existing content' },
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Edit/ }))

		const nameInput = screen.getByLabelText('Name') as HTMLInputElement
		// Name input must be enabled in edit mode so the user can rename.
		expect(nameInput).not.toBeDisabled()
		expect(nameInput.value).toBe('deploy')

		await user.clear(nameInput)
		await user.type(nameInput, 'deploy-v2')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			name: 'deploy',
			data: { name: 'deploy-v2', content: 'existing content' },
			newName: 'deploy-v2',
		})
	})

	it('omits the name field when the edit dialog save is not a rename', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		mockUseWorkspaceSkill.mockReturnValue({
			data: { ...buildSkill({ name: 'deploy' }), content: 'existing content' },
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Edit/ }))

		const contentInput = screen.getByLabelText('SKILL.md')
		await user.clear(contentInput)
		await user.type(contentInput, 'updated body')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			name: 'deploy',
			data: { content: 'updated body' },
			newName: undefined,
		})
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

describe('settings/skills helpers', () => {
	describe('deriveNameFromFileName', () => {
		it('strips the .md extension and lowercases', () => {
			expect(deriveNameFromFileName('Deploy.md')).toBe('deploy')
		})

		it('replaces spaces and underscores with hyphens', () => {
			expect(deriveNameFromFileName('review pr.md')).toBe('review-pr')
			expect(deriveNameFromFileName('deep_work.markdown')).toBe('deep-work')
		})

		it('drops disallowed characters and collapses hyphens', () => {
			expect(deriveNameFromFileName('Foo!@#$.md')).toBe('foo')
			expect(deriveNameFromFileName('--a  b--.md')).toBe('a-b')
		})

		it('falls back to imported-skill when sanitisation yields empty string', () => {
			expect(deriveNameFromFileName('!!!.md')).toBe('imported-skill')
		})

		it('truncates to 64 chars', () => {
			const long = `${'a'.repeat(80)}.md`
			expect(deriveNameFromFileName(long)).toHaveLength(64)
		})
	})

	describe('uniqueName', () => {
		it('returns the base when not taken', () => {
			expect(uniqueName('deploy', new Set())).toBe('deploy')
		})

		it('appends a numeric suffix on collision', () => {
			expect(uniqueName('deploy', new Set(['deploy']))).toBe('deploy-2')
			expect(uniqueName('deploy', new Set(['deploy', 'deploy-2']))).toBe('deploy-3')
		})
	})

	describe('toSkillUpload', () => {
		it('uses the frontmatter name when the SKILL.md parses with a valid name', () => {
			const raw = '---\nname: from-frontmatter\ndescription: d\n---\n\nbody'
			const result = toSkillUpload(raw, 'whatever.md')
			expect(result.baseName).toBe('from-frontmatter')
			expect(result.content).toBe(raw)
		})

		it('falls back to the sanitised filename when the content lacks frontmatter', () => {
			const raw = 'no frontmatter — just body text'
			const result = toSkillUpload(raw, 'My Skill.md')
			expect(result.baseName).toBe('my-skill')
			expect(result.content).toBe(raw)
		})

		it('falls back to the filename when the frontmatter name is not in the allowed format', () => {
			const raw = '---\nname: Not Valid!\ndescription: d\n---\n\nbody'
			const result = toSkillUpload(raw, 'fallback-name.md')
			expect(result.baseName).toBe('fallback-name')
		})
	})
})
