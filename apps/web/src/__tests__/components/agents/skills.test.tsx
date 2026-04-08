import { Skills } from '@/components/agents/skills'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildSkillListItem } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockMutate = vi.fn()
const mockDeleteMutate = vi.fn()
const mockSaveSkill = {
	mutate: mockMutate,
	isPending: false,
}

vi.mock('@/hooks/use-skills', () => ({
	useSkills: (...args: unknown[]) => mockUseSkills(...args),
	useSkill: (...args: unknown[]) => mockUseSkill(...args),
	useSaveSkill: () => mockSaveSkill,
	useDeleteSkill: () => ({ mutate: mockDeleteMutate }),
}))

const mockUseSkills = vi.fn()
const mockUseSkill = vi.fn()

vi.mock('@maskin/shared', () => ({
	parseSkillMd: vi.fn(),
}))

describe('Skills', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseSkill.mockReturnValue({ data: null })
	})

	it('shows "Loading skills..." when loading', () => {
		mockUseSkills.mockReturnValue({ data: undefined, isLoading: true })
		render(<Skills actorId="agent-1" />)
		expect(screen.getByText('Loading skills...')).toBeInTheDocument()
	})

	it('shows empty message when no skills', () => {
		render(<Skills actorId="agent-1" />)
		expect(screen.getByText(/No skills configured/)).toBeInTheDocument()
	})

	it('shows "Add Skill" and "Import SKILL.md" buttons', () => {
		render(<Skills actorId="agent-1" />)
		expect(screen.getByRole('button', { name: /Add Skill/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Import SKILL.md/ })).toBeInTheDocument()
	})

	it('renders skill name and description', () => {
		const skills = [buildSkillListItem({ name: 'deploy', description: 'Deploy to production' })]
		mockUseSkills.mockReturnValue({ data: skills, isLoading: false })
		render(<Skills actorId="agent-1" />)
		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('Deploy to production')).toBeInTheDocument()
	})

	it('shows confirm delete on delete click', async () => {
		const user = userEvent.setup()
		const skills = [buildSkillListItem({ name: 'deploy' })]
		mockUseSkills.mockReturnValue({ data: skills, isLoading: false })
		render(<Skills actorId="agent-1" />)

		await user.click(screen.getByRole('button', { name: 'Delete skill' }))
		expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
	})

	it('calls deleteSkill.mutate with skill name on confirm', async () => {
		const user = userEvent.setup()
		const skills = [buildSkillListItem({ name: 'deploy' })]
		mockUseSkills.mockReturnValue({ data: skills, isLoading: false })
		render(<Skills actorId="agent-1" />)

		await user.click(screen.getByRole('button', { name: 'Delete skill' }))
		await user.click(screen.getByRole('button', { name: 'Delete' }))
		expect(mockDeleteMutate).toHaveBeenCalledWith('deploy')
	})

	it('cancels delete and returns to normal state', async () => {
		const user = userEvent.setup()
		const skills = [buildSkillListItem({ name: 'deploy' })]
		mockUseSkills.mockReturnValue({ data: skills, isLoading: false })
		render(<Skills actorId="agent-1" />)

		await user.click(screen.getByRole('button', { name: 'Delete skill' }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
	})

	it('shows SkillForm when "Add Skill" clicked', async () => {
		const user = userEvent.setup()
		render(<Skills actorId="agent-1" />)

		await user.click(screen.getByRole('button', { name: /Add Skill/ }))

		expect(screen.getByText('Name')).toBeInTheDocument()
		expect(screen.getByText('Description')).toBeInTheDocument()
		expect(screen.getByText('Instructions')).toBeInTheDocument()
	})

	it('hides SkillForm when cancel clicked', async () => {
		const user = userEvent.setup()
		render(<Skills actorId="agent-1" />)

		await user.click(screen.getByRole('button', { name: /Add Skill/ }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(screen.getByRole('button', { name: /Add Skill/ })).toBeInTheDocument()
	})

	describe('SkillForm', () => {
		it('Save button disabled when name empty', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Add Skill/ }))

			expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		})

		it('Save button disabled when description empty', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Add Skill/ }))

			await user.type(screen.getByPlaceholderText('e.g. deploy, review-pr'), 'my-skill')

			expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
		})

		it('Save button enabled when name and description filled', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Add Skill/ }))

			await user.type(screen.getByPlaceholderText('e.g. deploy, review-pr'), 'my-skill')
			await user.type(
				screen.getByPlaceholderText('What this skill does and when to use it'),
				'Does things',
			)

			expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
		})

		it('shows advanced options when toggled', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Add Skill/ }))
			await user.click(screen.getByRole('button', { name: /Show advanced options/ }))

			expect(screen.getByText('Manual invocation only')).toBeInTheDocument()
			expect(screen.getByText('Allowed Tools')).toBeInTheDocument()
			expect(screen.getByText('Model Override')).toBeInTheDocument()
		})

		it('calls saveSkill.mutate with correct data on save', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Add Skill/ }))

			await user.type(screen.getByPlaceholderText('e.g. deploy, review-pr'), 'deploy')
			await user.type(
				screen.getByPlaceholderText('What this skill does and when to use it'),
				'Deploy to prod',
			)
			await user.type(
				screen.getByPlaceholderText('Markdown instructions for the agent...'),
				'Run deploy script',
			)

			await user.click(screen.getByRole('button', { name: 'Save' }))

			expect(mockMutate).toHaveBeenCalledWith(
				{
					skillName: 'deploy',
					data: {
						description: 'Deploy to prod',
						content: 'Run deploy script',
						frontmatter: undefined,
					},
				},
				expect.any(Object),
			)
		})

		it('disables name field when editing existing skill', async () => {
			const user = userEvent.setup()
			const skills = [buildSkillListItem({ name: 'deploy' })]
			mockUseSkills.mockReturnValue({ data: skills, isLoading: false })
			render(<Skills actorId="agent-1" />)

			await user.click(screen.getByRole('button', { name: 'Edit skill' }))
			const nameInput = screen.getByPlaceholderText('e.g. deploy, review-pr')
			expect(nameInput).toBeDisabled()
		})
	})

	describe('ImportSkillDialog', () => {
		it('Import button disabled when textarea empty', async () => {
			const user = userEvent.setup()
			render(<Skills actorId="agent-1" />)

			await user.click(screen.getByRole('button', { name: /Import SKILL.md/ }))

			expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
		})

		it('shows error for invalid SKILL.md format', async () => {
			const user = userEvent.setup()
			const { parseSkillMd } = await import('@maskin/shared')
			vi.mocked(parseSkillMd).mockImplementation(() => {
				throw new Error('parse error')
			})

			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Import SKILL.md/ }))

			const textarea = screen.getByPlaceholderText(/---/)
			await user.type(textarea, 'bad content')
			await user.click(screen.getByRole('button', { name: 'Import' }))

			expect(screen.getByText(/Invalid SKILL.md format/)).toBeInTheDocument()
		})

		it('shows error when name missing from frontmatter', async () => {
			const user = userEvent.setup()
			const { parseSkillMd } = await import('@maskin/shared')
			vi.mocked(parseSkillMd).mockReturnValue({
				name: '',
				description: 'test',
				content: 'test',
				frontmatter: {},
			})

			render(<Skills actorId="agent-1" />)
			await user.click(screen.getByRole('button', { name: /Import SKILL.md/ }))

			const textarea = screen.getByPlaceholderText(/---/)
			await user.type(textarea, '---\ndescription: test\n---')
			await user.click(screen.getByRole('button', { name: 'Import' }))

			expect(screen.getByText(/must have a "name" field/)).toBeInTheDocument()
		})
	})
})
