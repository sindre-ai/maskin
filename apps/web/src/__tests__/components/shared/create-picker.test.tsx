import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Router navigate — captured before importing the component.
const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', async () => {
	const actual =
		await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
	return {
		...actual,
		useNavigate: () => navigateSpy,
	}
})

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			create: vi.fn(),
		},
		actors: {
			create: vi.fn(),
		},
		triggers: {
			create: vi.fn(),
		},
		workspaces: {
			members: {
				add: vi.fn().mockResolvedValue({ added: true }),
			},
		},
	},
}))

const captureSpy = vi.fn()
vi.mock('@/lib/posthog', () => ({
	capture: (...args: unknown[]) => captureSpy(...args),
	isPosthogReady: () => true,
	__setInitializedForTesting: () => {},
}))

// Stub navigator.clipboard — some downstream hooks poke it.
Object.defineProperty(window, 'requestAnimationFrame', {
	value: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	writable: true,
})

import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { api } from '@/lib/api'
import { setStoredActor } from '@/lib/auth'
import { createWorkspaceWrapper } from '../../setup'

beforeEach(() => {
	localStorage.clear()
	vi.mocked(api.objects.create).mockReset()
	vi.mocked(api.actors.create).mockReset()
	vi.mocked(api.triggers.create).mockReset()
	vi.mocked(api.workspaces.members.add).mockReset().mockResolvedValue({ added: true })
	navigateSpy.mockReset()
	captureSpy.mockReset()
})

afterEach(() => {
	vi.restoreAllMocks()
})

function renderWithWorkspace(
	ui: React.ReactElement,
	overrides: { settings?: Record<string, unknown> } = {},
) {
	const Wrapper = createWorkspaceWrapper({ settings: overrides.settings ?? {} })
	return render(ui, { wrapper: Wrapper })
}

describe('CreatePicker', () => {
	it('does not render the type picker when defaultType is set', () => {
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} defaultType="object" />)
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		// The type radio group is skipped — no Agent/Trigger radio buttons.
		expect(screen.queryByRole('radio', { name: /agent/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('radio', { name: /trigger/i })).not.toBeInTheDocument()
	})

	it('shows the type picker when defaultType is omitted', () => {
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		expect(screen.getByRole('radio', { name: /object/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /agent/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /trigger/i })).toBeInTheDocument()
	})

	it('creates an object with the workspace default status and navigates to the detail page', async () => {
		const user = userEvent.setup()
		vi.mocked(api.objects.create).mockResolvedValue({
			id: 'obj-42',
			workspaceId: 'ws-1',
			type: 'bet',
			title: 'Ship it',
			content: null,
			status: 'active',
			metadata: null,
			driver: null,
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		})
		const onOpenChange = vi.fn()
		renderWithWorkspace(
			<CreatePicker
				open
				onOpenChange={onOpenChange}
				defaultType="object"
				defaultObjectSubtype="bet"
			/>,
			{ settings: { statuses: { bet: ['active', 'shipped'] } } },
		)
		const input = screen.getByLabelText(/title/i)
		await user.type(input, 'Ship it')
		await user.click(screen.getByRole('button', { name: /^create$/i }))
		await waitFor(() => expect(api.objects.create).toHaveBeenCalled())
		expect(vi.mocked(api.objects.create).mock.calls[0]?.[1]).toMatchObject({
			type: 'bet',
			title: 'Ship it',
			status: 'active',
		})
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/objects/$objectId',
				params: expect.objectContaining({ objectId: 'obj-42' }),
			}),
		)
		await waitFor(() => {
			const calls = captureSpy.mock.calls.filter((c) => c[0] === 'object_created')
			expect(calls.length).toBe(1)
			expect(calls[0]?.[1]).toMatchObject({ entity_id: 'obj-42', object_subtype: 'bet' })
		})
	})

	it('creates an agent, adds workspace membership, and navigates to the agent detail page', async () => {
		const user = userEvent.setup()
		setStoredActor({ id: 'actor-me', name: 'Me', type: 'human', email: null })
		vi.mocked(api.actors.create).mockResolvedValue({
			id: 'actor-77',
			name: 'Router',
			type: 'agent',
			email: null,
			description: null,
			system_prompt: null,
			tools: null,
			memory: null,
			llm_provider: null,
			llm_config: null,
			isSystem: false,
			agentState: 'idle',
			agentStateUpdatedAt: null,
			createdAt: null,
			updatedAt: null,
			api_key: 'ank_x',
		})
		const onOpenChange = vi.fn()
		renderWithWorkspace(<CreatePicker open onOpenChange={onOpenChange} defaultType="agent" />)
		await user.type(screen.getByLabelText(/title/i), 'Router')
		await user.click(screen.getByRole('button', { name: /^create$/i }))
		await waitFor(() => expect(api.actors.create).toHaveBeenCalled())
		expect(vi.mocked(api.actors.create).mock.calls[0]?.[0]).toMatchObject({
			type: 'agent',
			name: 'Router',
		})
		await waitFor(() =>
			expect(api.workspaces.members.add).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ actor_id: 'actor-77' }),
			),
		)
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/agents/$agentId',
				params: expect.objectContaining({ agentId: 'actor-77' }),
			}),
		)
	})

	it('creates a disabled trigger with placeholder config using the stored actor as target', async () => {
		const user = userEvent.setup()
		setStoredActor({ id: 'actor-me', name: 'Me', type: 'human', email: null })
		vi.mocked(api.triggers.create).mockResolvedValue({
			id: 'trig-9',
			workspaceId: 'ws-1',
			name: 'Nightly',
			type: 'cron',
			config: {},
			actionPrompt: '',
			targetActorId: 'actor-me',
			enabled: false,
			createdBy: 'actor-me',
			createdAt: null,
			updatedAt: null,
		})
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} defaultType="trigger" />)
		await user.type(screen.getByLabelText(/title/i), 'Nightly')
		await user.click(screen.getByRole('button', { name: /^create$/i }))
		await waitFor(() => expect(api.triggers.create).toHaveBeenCalled())
		const payload = vi.mocked(api.triggers.create).mock.calls[0]?.[1]
		expect(payload).toMatchObject({
			name: 'Nightly',
			type: 'cron',
			enabled: false,
			target_actor_id: 'actor-me',
		})
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/triggers/$triggerId',
				params: expect.objectContaining({ triggerId: 'trig-9' }),
			}),
		)
	})

	it('leaves title empty and the create button disabled until a title is typed', () => {
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} defaultType="object" />)
		const createButton = screen.getByRole('button', { name: /^create$/i })
		expect(createButton).toBeDisabled()
	})
})

describe('isCreateShortcut', () => {
	function makeEvent(overrides: Partial<KeyboardEvent> = {}, target?: EventTarget | null) {
		const base: Partial<KeyboardEvent> = {
			key: 'c',
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			target: target ?? document.body,
			...overrides,
		}
		return base as KeyboardEvent
	}

	it('matches lowercase and uppercase c', () => {
		expect(isCreateShortcut(makeEvent({ key: 'c' }))).toBe(true)
		expect(isCreateShortcut(makeEvent({ key: 'C' }))).toBe(true)
	})

	it('ignores other keys', () => {
		expect(isCreateShortcut(makeEvent({ key: 'v' }))).toBe(false)
	})

	it('ignores c with modifiers so cmd+c/ctrl+c/alt+c keep their meaning', () => {
		expect(isCreateShortcut(makeEvent({ metaKey: true }))).toBe(false)
		expect(isCreateShortcut(makeEvent({ ctrlKey: true }))).toBe(false)
		expect(isCreateShortcut(makeEvent({ altKey: true }))).toBe(false)
	})

	it('ignores keystrokes originating from inputs, textareas, or contenteditable', () => {
		const input = document.createElement('input')
		const textarea = document.createElement('textarea')
		const div = document.createElement('div')
		div.setAttribute('contenteditable', 'true')
		expect(isCreateShortcut(makeEvent({}, input))).toBe(false)
		expect(isCreateShortcut(makeEvent({}, textarea))).toBe(false)
		expect(isCreateShortcut(makeEvent({}, div))).toBe(false)
	})
})
