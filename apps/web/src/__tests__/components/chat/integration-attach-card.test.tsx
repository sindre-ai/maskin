import type { McpPresetResponse, MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const approveMutate = vi.fn()
let presets: McpPresetResponse[] = []
let presetsLoading = false
let role: 'owner' | 'admin' | 'member' = 'admin'
let memberType: 'human' | 'agent' = 'human'

vi.mock('@/hooks/use-integrations', () => ({
	useMcpPresets: () => ({
		data: presetsLoading ? undefined : { presets },
		isLoading: presetsLoading,
	}),
	useApproveIntegrationAttach: () => ({ mutate: approveMutate, isPending: false }),
}))
vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return {
		...actual,
		useActors: () => ({ data: [{ id: 'agent-sales', name: 'Sales Rep', type: 'agent' }] }),
	}
})
vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [{ actorId: 'me', type: memberType, role }] }),
}))
vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))
vi.mock('@/hooks/use-objects', () => ({ useObject: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-conversation', () => ({
	useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
	useRetryMessage: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-files', () => ({
	useFiles: () => ({ data: [] }),
	useFile: () => ({ data: undefined }),
}))

import { IntegrationAttachCard } from '@/components/chat/integration-attach-card'
import { MessageBubble } from '@/components/chat/message-bubble'

const PRESET_ID = 'linkedin-krumhausen-personal'

function preset(overrides: Partial<McpPresetResponse> = {}): McpPresetResponse {
	return {
		preset_id: PRESET_ID,
		provider: 'linkedin-unipile',
		provider_label: 'LinkedIn',
		label: 'Sebastian Krumhausen',
		integration_id: 'int-1',
		key: PRESET_ID,
		auto_injected: false,
		server: { type: 'http', url: 'https://example.com' },
		attached: false,
		...overrides,
	}
}

function renderCard() {
	return render(
		<IntegrationAttachCard workspaceId="ws-1" actorId="agent-sales" presetId={PRESET_ID} />,
		{ wrapper: TestWrapper },
	)
}

describe('IntegrationAttachCard', () => {
	beforeEach(() => {
		approveMutate.mockClear()
		presets = [preset()]
		presetsLoading = false
		role = 'admin'
		memberType = 'human'
	})

	it('lets an admin approve, sending only the agent and preset ids', async () => {
		renderCard()

		await userEvent
			.setup()
			.click(screen.getByRole('button', { name: 'Allow Sales Rep to use Sebastian Krumhausen' }))

		expect(approveMutate).toHaveBeenCalledWith({ actorId: 'agent-sales', presetId: PRESET_ID })
	})

	it('lets an owner approve too', () => {
		role = 'owner'
		renderCard()
		expect(screen.getByRole('button', { name: /Allow Sales Rep to use/ })).toBeInTheDocument()
	})

	it('offers no approve button to a member who cannot approve, and says who can', () => {
		role = 'member'
		renderCard()
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
		expect(screen.getByText(/Waiting for a workspace admin/)).toBeInTheDocument()
	})

	it('offers a second action for every agent a disconnect stripped it from', async () => {
		presets = [
			preset({
				affected_agents: [
					{ id: 'agent-sales', name: 'Sales Rep' },
					{ id: 'agent-ir', name: 'IR' },
					{ id: 'agent-cos', name: 'Chief of Staff' },
				],
			}),
		]
		renderCard()

		await userEvent
			.setup()
			.click(screen.getByRole('button', { name: 'Attach to all 3 affected agents' }))

		expect(approveMutate).toHaveBeenCalledWith({
			actorId: 'agent-sales',
			presetId: PRESET_ID,
			allAffected: true,
		})
	})

	it('shows no second action when the asked-about agent is the only one affected', () => {
		presets = [preset({ affected_agents: [{ id: 'agent-sales', name: 'Sales Rep' }] })]
		renderCard()
		expect(screen.queryByRole('button', { name: /affected agents/ })).not.toBeInTheDocument()
	})

	it('reads as done, with no buttons, once the agent holds the entry', () => {
		presets = [preset({ attached: true })]
		renderCard()
		expect(screen.getByText(/Sales Rep can use Sebastian Krumhausen/)).toBeInTheDocument()
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('says the integration is gone when its preset no longer exists', () => {
		presets = []
		renderCard()
		expect(screen.getByText(/no longer connected/)).toBeInTheDocument()
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('renders nothing while the preset list loads', () => {
		presetsLoading = true
		const { container } = renderCard()
		expect(container).toBeEmptyDOMElement()
	})
})

describe('MessageBubble: integration_attach marker', () => {
	const message: MessageResponse = {
		id: 7,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Chief of Staff',
		actorType: 'agent',
		kind: 'message',
		content: 'Allow **Sales Rep** to use **Sebastian Krumhausen**.',
		metadata: {
			integration_attach: { session_id: 's-1', actor_id: 'agent-sales', preset_id: PRESET_ID },
		},
		editedAt: null,
		sessionId: 's-1',
		createdAt: new Date().toISOString(),
	}

	beforeEach(() => {
		role = 'admin'
		memberType = 'human'
		presets = [preset()]
		presetsLoading = false
	})

	afterEach(() => localStorage.removeItem('ff:integration-attach-card'))

	it('draws the card when the flag is on', () => {
		localStorage.setItem('ff:integration-attach-card', 'on')
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.getByText('Approve tool access')).toBeInTheDocument()
	})

	it('draws no card when the flag is off, and the markdown still says what was asked', () => {
		localStorage.setItem('ff:integration-attach-card', 'off')
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.queryByText('Approve tool access')).not.toBeInTheDocument()
		expect(screen.getByText(/Sebastian Krumhausen/)).toBeInTheDocument()
	})
})
