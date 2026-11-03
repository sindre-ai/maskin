import { AgentSkillsSection } from '@/components/agents/agent-skills-section'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const listPersonalSkills = vi.fn()
const listAttachedWorkspaceSkills = vi.fn()
const listWorkspaceSkills = vi.fn()
const listIntegrations = vi.fn()

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			skills: {
				...actual.api.skills,
				list: (...args: unknown[]) => listPersonalSkills(...args),
			},
			workspaceSkills: {
				...actual.api.workspaceSkills,
				list: (...args: unknown[]) => listWorkspaceSkills(...args),
				listForActor: (...args: unknown[]) => listAttachedWorkspaceSkills(...args),
			},
			integrations: {
				...actual.api.integrations,
				list: (...args: unknown[]) => listIntegrations(...args),
			},
		},
	}
})

describe('AgentSkillsSection', () => {
	beforeEach(() => {
		listPersonalSkills.mockReset()
		listAttachedWorkspaceSkills.mockReset()
		listWorkspaceSkills.mockReset()
		listIntegrations.mockReset()
		listWorkspaceSkills.mockResolvedValue([])
		listIntegrations.mockResolvedValue([])
	})

	it('renders a labelled section with the total attached count and both origins', async () => {
		listPersonalSkills.mockResolvedValue([
			{ name: 'deploy', description: 'Ship a build to prod' },
			{ name: 'triage', description: 'Sort incoming bugs' },
		])
		listAttachedWorkspaceSkills.mockResolvedValue([
			{ id: 'ws-skill-1', name: 'brand-voice', description: 'House voice guide' },
		])

		const agent = buildActorResponse({ id: 'agent-skills', type: 'agent' })
		render(<AgentSkillsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const section = await screen.findByRole('region', { name: 'Skills' })
		expect(section).toBeInTheDocument()

		// Total count = 2 personal + 1 workspace = 3
		expect(await screen.findByLabelText('3 skills attached')).toHaveTextContent('· 3')

		// Both origin groups labelled inside the Skills body (personal + workspace).
		expect(await screen.findByText('Personal')).toBeInTheDocument()
		expect(screen.getByText('Workspace')).toBeInTheDocument()

		// Each skill's name is listed.
		expect(await screen.findByText('brand-voice')).toBeInTheDocument()
		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('triage')).toBeInTheDocument()

		// v2 has no Manage switch — the section is editable at rest (mockup 2448–2467).
		expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument()
	})

	it('keeps the add affordances reachable on an empty section', async () => {
		listPersonalSkills.mockResolvedValue([])
		listAttachedWorkspaceSkills.mockResolvedValue([])
		listWorkspaceSkills.mockResolvedValue([
			{ id: 'ws-skill-avail', name: 'brand-voice', description: null, isFolder: false },
		])

		const agent = buildActorResponse({ id: 'agent-empty', type: 'agent' })
		render(<AgentSkillsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(await screen.findByLabelText('0 skills attached')).toHaveTextContent('· 0')
		expect(await screen.findByRole('button', { name: /Add Skill/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Import SKILL/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Attach workspace skill/i })).toBeInTheDocument()
	})

	// The mockup lists what is attached and puts "add another" at the end of the
	// list, not above it (mockup 2450–2456).
	it('draws the attach control after the attached rows, not before them', async () => {
		listPersonalSkills.mockResolvedValue([])
		listAttachedWorkspaceSkills.mockResolvedValue([])
		// A non-empty workspace catalogue skips the "create one in Settings → Skills"
		// empty-state link that requires a RouterProvider to render.
		listWorkspaceSkills.mockResolvedValue([
			{ id: 'ws-skill-avail', name: 'brand-voice', description: null, isFolder: false },
		])

		listAttachedWorkspaceSkills.mockResolvedValue([
			{ id: 'ws-skill-1', name: 'brand-voice', description: 'House voice guide' },
		])

		const agent = buildActorResponse({ id: 'agent-manage', type: 'agent' })
		render(<AgentSkillsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const row = await screen.findByText('brand-voice')
		const attach = await screen.findByRole('button', { name: /Attach workspace skill/i })
		// DOCUMENT_POSITION_FOLLOWING === 4: the attach control comes after the row.
		expect(row.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})
})
