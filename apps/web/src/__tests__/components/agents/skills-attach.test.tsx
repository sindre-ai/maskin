import { Skills } from '@/components/agents/skills'
import type { AttachedWorkspaceSkill, WorkspaceSkillListItem } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

// cmdk uses ResizeObserver internally
global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const mockUseSkills = vi.fn()

vi.mock('@/hooks/use-skills', () => ({
	useSkills: (...args: unknown[]) => mockUseSkills(...args),
	useSkill: () => ({ data: null }),
	useSaveSkill: () => ({ mutate: vi.fn(), isPending: false }),
	useDeleteSkill: () => ({ mutate: vi.fn() }),
}))

const mockAttach = vi.fn()
const mockDetach = vi.fn()
const mockUseWorkspaceSkills = vi.fn()
const mockUseAgentSkillAttachments = vi.fn()

vi.mock('@/hooks/use-workspace-skills', () => ({
	useWorkspaceSkills: (...args: unknown[]) => mockUseWorkspaceSkills(...args),
}))

vi.mock('@/hooks/use-agent-skill-attachments', () => ({
	useAgentSkillAttachments: (...args: unknown[]) => mockUseAgentSkillAttachments(...args),
	useAttachSkill: () => ({ mutate: mockAttach }),
	useDetachSkill: () => ({ mutate: mockDetach }),
}))

vi.mock('@maskin/shared', () => ({
	parseSkillMd: vi.fn(),
}))

function buildWorkspaceSkill(
	overrides: Partial<WorkspaceSkillListItem> = {},
): WorkspaceSkillListItem {
	return {
		id: 'ws-skill-1',
		workspaceId: 'ws-1',
		name: 'deploy',
		description: 'Deploy to prod',
		storageKey: 'workspaces/ws-1/skills/deploy/SKILL.md',
		sizeBytes: 512,
		isValid: true,
		createdBy: 'actor-1',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides,
	}
}

function buildAttachedSkill(
	overrides: Partial<AttachedWorkspaceSkill> = {},
): AttachedWorkspaceSkill {
	return {
		...buildWorkspaceSkill(),
		attachedAt: '2026-01-02T00:00:00Z',
		...overrides,
	}
}

describe('Skills — Workspace Skills section', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseWorkspaceSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseAgentSkillAttachments.mockReturnValue({ data: [], isLoading: false })
	})

	it('renders empty state with settings link when no workspace skills exist', () => {
		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByText(/No workspace skills in this workspace yet/)).toBeInTheDocument()
		const link = screen.getByRole('link', { name: /Settings → Skills/ })
		expect(link).toHaveAttribute('href', '/$workspaceId/settings/skills')
	})

	it('renders Workspace and Personal section headers with zero counts when both are empty', () => {
		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		const workspaceHeader = screen.getByRole('heading', { name: /workspace.*0/i })
		const personalHeader = screen.getByRole('heading', { name: /personal.*0/i })
		expect(workspaceHeader).toBeInTheDocument()
		expect(personalHeader).toBeInTheDocument()
	})

	it('does not show the attach dropdown trigger in empty state', () => {
		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.queryByRole('button', { name: 'Attach workspace skill' })).not.toBeInTheDocument()
	})

	it('renders attached rows even when the workspace skill list is empty', () => {
		// Guards the case where the attachments endpoint returns rows but the
		// workspace-skills list endpoint is empty (deleted skill, transient
		// permission filter, stale cache). The attached skills must still appear.
		mockUseWorkspaceSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [buildAttachedSkill({ id: 'skill-orphan', name: 'deploy', description: 'Ship it' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByRole('button', { name: 'Remove deploy' })).toBeInTheDocument()
		expect(screen.getByText('Ship it')).toBeInTheDocument()
		expect(screen.queryByText(/No workspace skills in this workspace yet/)).not.toBeInTheDocument()
	})

	it('shows attach dropdown trigger when workspace skills exist', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'a', name: 'deploy' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByRole('button', { name: 'Attach workspace skill' })).toBeInTheDocument()
	})

	it('populates dropdown with all workspace skills when opened', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildWorkspaceSkill({ id: 'a', name: 'deploy', description: 'Ship it' }),
				buildWorkspaceSkill({ id: 'b', name: 'review-pr', description: 'Review code' }),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Attach workspace skill' }))

		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('Ship it')).toBeInTheDocument()
		expect(screen.getByText('review-pr')).toBeInTheDocument()
		expect(screen.getByText('Review code')).toBeInTheDocument()
	})

	it('filters skills by name as the user types in the search input', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildWorkspaceSkill({ id: 'a', name: 'deploy', description: 'Ship it' }),
				buildWorkspaceSkill({ id: 'b', name: 'review-pr', description: 'Review code' }),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Attach workspace skill' }))

		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('review-pr')).toBeInTheDocument()

		await user.type(screen.getByPlaceholderText('Search workspace skills...'), 'depl')

		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.queryByText('review-pr')).not.toBeInTheDocument()
	})

	it('renders workspace skills in alphabetical order regardless of input order', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildWorkspaceSkill({ id: 'a', name: 'zeta', description: '' }),
				buildWorkspaceSkill({ id: 'b', name: 'Alpha', description: '' }),
				buildWorkspaceSkill({ id: 'c', name: 'mango', description: '' }),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Attach workspace skill' }))

		const labels = screen.getAllByRole('option').map((el) => el.textContent?.trim())
		expect(labels).toEqual(['Alpha', 'mango', 'zeta'])
	})

	it('calls attach mutation with workspaceSkillId when an unattached skill is selected', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Attach workspace skill' }))
		await user.click(screen.getByText('deploy'))

		expect(mockAttach).toHaveBeenCalledWith('skill-abc')
		expect(mockDetach).not.toHaveBeenCalled()
	})

	it('calls detach mutation when an already-attached skill is selected from the dropdown', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [buildAttachedSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Attach workspace skill' }))
		// Click the skill in the dropdown. Use getAllByText since it also appears in the attached rows.
		const matches = screen.getAllByText('deploy')
		await user.click(matches[matches.length - 1])

		expect(mockDetach).toHaveBeenCalledWith('skill-abc')
		expect(mockAttach).not.toHaveBeenCalled()
	})

	it('renders attached skills as removable rows', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [buildAttachedSkill({ id: 'skill-abc', name: 'deploy', description: 'Ship it' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByRole('button', { name: 'Remove deploy' })).toBeInTheDocument()
		expect(screen.getByText('Ship it')).toBeInTheDocument()
	})

	it('renders both attached workspace skills and personal skills under their respective section headers', () => {
		mockUseSkills.mockReturnValue({
			data: [
				{
					name: 'personal-one',
					description: 'A personal skill',
				},
			],
			isLoading: false,
		})
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'a', name: 'deploy' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [buildAttachedSkill({ id: 'a', name: 'deploy', description: 'Ship it' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByRole('heading', { name: /workspace.*1/i })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: /personal.*1/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Remove deploy' })).toBeInTheDocument()
		expect(screen.getByText('personal-one')).toBeInTheDocument()
		expect(screen.getByText('A personal skill')).toBeInTheDocument()
	})

	it('reflects attached count in the Workspace section header', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildWorkspaceSkill({ id: 'a', name: 'deploy' }),
				buildWorkspaceSkill({ id: 'b', name: 'review-pr' }),
			],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [
				buildAttachedSkill({ id: 'a', name: 'deploy' }),
				buildAttachedSkill({ id: 'b', name: 'review-pr' }),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByRole('heading', { name: /workspace.*2/i })).toBeInTheDocument()
	})

	it('calls detach when Remove is clicked on an attached row', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [buildAttachedSkill({ id: 'skill-abc', name: 'deploy' })],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Remove deploy' }))

		expect(mockDetach).toHaveBeenCalledWith('skill-abc')
	})

	it('renders a folder badge with file count on a folder-skill row', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-docx', name: 'docx' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [
				buildAttachedSkill({
					id: 'skill-docx',
					name: 'docx',
					description: 'Generate Word documents',
					isFolder: true,
					fileCount: 3,
				}),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByLabelText('Folder skill with 3 files')).toBeInTheDocument()
		expect(screen.getByText('3 files')).toBeInTheDocument()
		// Single-file affordances are still present — folder rows reuse the row, no extra editor.
		expect(screen.getByRole('button', { name: 'Remove docx' })).toBeInTheDocument()
	})

	it('uses singular "file" wording when a folder skill has exactly one bundled file', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-one', name: 'one-shot' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [
				buildAttachedSkill({
					id: 'skill-one',
					name: 'one-shot',
					isFolder: true,
					fileCount: 1,
				}),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByLabelText('Folder skill with 1 file')).toBeInTheDocument()
		expect(screen.getByText('1 file')).toBeInTheDocument()
	})

	it('does not render a folder badge on a single-file (isFolder=false) attached row', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildWorkspaceSkill({ id: 'skill-md', name: 'deploy' })],
			isLoading: false,
		})
		mockUseAgentSkillAttachments.mockReturnValue({
			data: [
				buildAttachedSkill({
					id: 'skill-md',
					name: 'deploy',
					description: 'Ship it',
					isFolder: false,
					fileCount: null,
				}),
			],
			isLoading: false,
		})

		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.queryByText(/file(s)?$/)).not.toBeInTheDocument()
		expect(screen.queryByLabelText(/Folder skill with/)).not.toBeInTheDocument()
		// The row keeps its original shape — name, description, Remove.
		expect(screen.getByRole('button', { name: 'Remove deploy' })).toBeInTheDocument()
		expect(screen.getByText('Ship it')).toBeInTheDocument()
	})
})
