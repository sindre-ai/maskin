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

vi.mock('@/hooks/use-skills', () => ({
	useSkills: () => ({ data: [], isLoading: false }),
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
		mockUseWorkspaceSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseAgentSkillAttachments.mockReturnValue({ data: [], isLoading: false })
	})

	it('renders empty state with settings link when no workspace skills exist', () => {
		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.getByText(/No workspace skills attached/)).toBeInTheDocument()
		const link = screen.getByRole('link', { name: /Settings → Skills/ })
		expect(link).toHaveAttribute('href', '/$workspaceId/settings/skills')
	})

	it('does not show the attach dropdown trigger in empty state', () => {
		render(
			<TestWrapper>
				<Skills actorId="agent-1" />
			</TestWrapper>,
		)

		expect(screen.queryByRole('button', { name: 'Attach workspace skill' })).not.toBeInTheDocument()
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
})
