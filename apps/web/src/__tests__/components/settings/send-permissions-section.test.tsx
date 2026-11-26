import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockWorkspace = { current: buildWorkspaceWithRole({ role: 'admin' }) }
const mockActor = vi.fn()

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	// Keep the real WorkspaceContext: useCanWrite reads it directly.
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({
		workspace: mockWorkspace.current,
		workspaceId: mockWorkspace.current.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/lib/auth', () => ({ getStoredActor: () => mockActor() }))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			...actual.api,
			sendPermissions: {
				get: (...a: unknown[]) => mockGet(...a),
				set: (...a: unknown[]) => mockSet(...a),
			},
		},
	}
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { SendPermissionsSection } from '@/components/settings/send-permissions-section'

const KINDS = [
	'email',
	'linkedin_message',
	'linkedin_connection_request',
	'linkedin_inmail',
	'linkedin_post',
	'linkedin_comment',
	'linkedin_comment_reply',
	'linkedin_post_edit',
	'slack_message',
] as const

function view() {
	const defaults = Object.fromEntries(
		KINDS.map((k) => [
			k,
			{ mode: k === 'email' ? 'ask_first' : 'always_allow', source: 'starting' },
		]),
	)
	return {
		kinds: [...KINDS],
		modes: ['always_allow', 'ask_first', 'deny'],
		workspace_default: defaults,
		agents: [
			{
				agent_id: 'agent-1',
				name: 'Copywriter',
				settings: { ...defaults, linkedin_post: { mode: 'deny', source: 'agent' } },
			},
		],
	}
}

function renderSection() {
	return render(
		<TestWrapper>
			<SendPermissionsSection workspaceId={mockWorkspace.current.id} />
		</TestWrapper>,
	)
}

describe('Settings > Send permissions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGet.mockResolvedValue(view())
		mockSet.mockResolvedValue({})
		mockActor.mockReturnValue({ id: 'me', name: 'Me', type: 'human', email: null })
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'admin' })
	})

	it('shows the workspace default row and each agent, with the agent’s own setting', async () => {
		renderSection()
		expect(await screen.findByText('Workspace default')).toBeInTheDocument()
		expect(screen.getByText('Copywriter')).toBeInTheDocument()
		expect(screen.getByLabelText('Workspace default for Email')).toHaveTextContent('Ask first')
		expect(screen.getByLabelText('Workspace default for Slack message')).toHaveTextContent(
			'Always allow',
		)
		expect(screen.getByLabelText('LinkedIn post for Copywriter')).toHaveTextContent('Deny')
		// No setting of its own: shows what it follows.
		expect(screen.getByLabelText('Email for Copywriter')).toHaveTextContent('Default (Ask first)')
	})

	it('saves an agent’s setting', async () => {
		const user = userEvent.setup()
		renderSection()
		await user.click(await screen.findByLabelText('Email for Copywriter'))
		await user.click(await screen.findByRole('option', { name: 'Always allow' }))
		expect(mockSet).toHaveBeenCalledWith(mockWorkspace.current.id, {
			agent_id: 'agent-1',
			kind: 'email',
			mode: 'always_allow',
		})
	})

	it('puts an agent back on the workspace default with mode null', async () => {
		const user = userEvent.setup()
		renderSection()
		await user.click(await screen.findByLabelText('LinkedIn post for Copywriter'))
		await user.click(await screen.findByRole('option', { name: /^Default/ }))
		expect(mockSet).toHaveBeenCalledWith(mockWorkspace.current.id, {
			agent_id: 'agent-1',
			kind: 'linkedin_post',
			mode: null,
		})
	})

	it('saves the workspace default', async () => {
		const user = userEvent.setup()
		renderSection()
		await user.click(await screen.findByLabelText('Workspace default for Email'))
		const list = await screen.findByRole('listbox')
		expect(within(list).queryByRole('option', { name: /^Default/ })).not.toBeInTheDocument()
		await user.click(within(list).getByRole('option', { name: 'Deny' }))
		expect(mockSet).toHaveBeenCalledWith(mockWorkspace.current.id, {
			agent_id: null,
			kind: 'email',
			mode: 'deny',
		})
	})

	it('is read-only for a member who is not an admin or owner', async () => {
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'member' })
		renderSection()
		const control = await screen.findByLabelText('Email for Copywriter')
		expect(control).toBeDisabled()
		expect(screen.getByText(/Only a workspace admin or owner can change/)).toBeInTheDocument()
	})

	it('is read-only for a viewer', async () => {
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'viewer' })
		renderSection()
		expect(await screen.findByLabelText('Email for Copywriter')).toBeDisabled()
	})
})
