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
			list: vi.fn(),
		},
		conversations: {
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
import { type ModuleWebDefinition, clearWebModules, registerWebModule } from '@maskin/module-sdk'
import { createWorkspaceWrapper } from '../../setup'

// The chip row and the `/` menu render the workspace's *enabled* object types,
// so the module registry has to be populated for either to appear.
const workModule: ModuleWebDefinition = {
	id: 'work',
	name: 'Work',
	navItems: [],
	objectTypeTabs: [
		{ label: 'Insights', value: 'insight' },
		{ label: 'Bets', value: 'bet' },
		{ label: 'Tasks', value: 'task' },
	],
}

const COACH = {
	id: 'agent-coach',
	name: 'Workspace Coach',
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
}

beforeEach(() => {
	localStorage.clear()
	clearWebModules()
	registerWebModule(workModule)
	vi.mocked(api.objects.create).mockReset()
	vi.mocked(api.actors.create).mockReset()
	vi.mocked(api.actors.list)
		.mockReset()
		.mockResolvedValue([COACH] as never)
	vi.mocked(api.conversations.create).mockReset()
	vi.mocked(api.triggers.create).mockReset()
	vi.mocked(api.workspaces.members.add).mockReset().mockResolvedValue({ added: true })
	navigateSpy.mockReset()
	captureSpy.mockReset()
})

afterEach(() => {
	clearWebModules()
	vi.restoreAllMocks()
})

const DEFAULT_SETTINGS = { enabled_modules: ['work'] }

function renderWithWorkspace(
	ui: React.ReactElement,
	overrides: { settings?: Record<string, unknown> } = {},
) {
	const Wrapper = createWorkspaceWrapper({
		settings: { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) },
	})
	return render(ui, { wrapper: Wrapper })
}

describe('CreatePicker', () => {
	it('seeds the type pill and hides the chip row when defaultType is set', () => {
		renderWithWorkspace(
			<CreatePicker open onOpenChange={() => {}} defaultType="object" defaultObjectSubtype="bet" />,
		)
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText('New bet')).toBeInTheDocument()
		// The chip row only renders in the empty greet state — a seeded type
		// replaces it with the pill (clearable, unlike the old locked mode).
		expect(screen.queryAllByRole('radio')).toHaveLength(0)
		expect(screen.getByRole('button', { name: /remove bet type/i })).toBeInTheDocument()
	})

	it('shows the workspace object types as chips when defaultType is omitted', () => {
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		expect(screen.getByRole('radio', { name: 'Insight' })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Bet' })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Task' })).toBeInTheDocument()
		// Agent / trigger / loop are not object types — they live in the `/` menu.
		expect(screen.queryByRole('radio', { name: /agent/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('radio', { name: /trigger/i })).not.toBeInTheDocument()
	})

	it('hands an object description to the routed agent as a conversation', async () => {
		const user = userEvent.setup()
		vi.mocked(api.conversations.create).mockResolvedValue({
			id: 'conv-7',
			title: 'Ship it',
		} as never)
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
		// The routing target has to resolve before the send button enables.
		const send = await screen.findByRole('button', { name: 'Send to Workspace Coach' })
		await user.type(screen.getByLabelText(/title/i), 'Ship it')
		await waitFor(() => expect(send).toBeEnabled())
		await user.click(send)

		await waitFor(() => expect(api.conversations.create).toHaveBeenCalled())
		expect(vi.mocked(api.conversations.create).mock.calls[0]?.[1]).toMatchObject({
			title: 'Ship it',
			participant_actor_ids: ['agent-coach'],
			initial_message: 'Create a bet from this:\n\nShip it',
		})
		// Nothing is created client-side — the agent does the structuring.
		expect(api.objects.create).not.toHaveBeenCalled()
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/chats/$conversationId',
				params: expect.objectContaining({ conversationId: 'conv-7' }),
			}),
		)
		// `object_created` fires on a server-confirmed object — there isn't one yet.
		expect(captureSpy.mock.calls.filter((c) => c[0] === 'object_created')).toHaveLength(0)
	})

	it('shows the routing card and the chat note for free text with no type', async () => {
		const user = userEvent.setup()
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		await user.type(screen.getByLabelText(/title/i), 'Why did billing go quiet?')

		expect(screen.getByText('Routing')).toBeInTheDocument()
		expect(await screen.findByLabelText('Agent that picks this up')).toBeInTheDocument()
		expect(screen.getByText(/opens it as a chat in/i)).toBeInTheDocument()
		expect(screen.getByText(/picks this up when you send/i)).toBeInTheDocument()
	})

	it('opens a chat conversation for free text with no type', async () => {
		const user = userEvent.setup()
		vi.mocked(api.conversations.create).mockResolvedValue({ id: 'conv-9' } as never)
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		await user.type(screen.getByLabelText(/title/i), 'Catch me up on billing')
		const send = await screen.findByRole('button', { name: 'Send to Workspace Coach' })
		await waitFor(() => expect(send).toBeEnabled())
		await user.click(send)

		await waitFor(() => expect(api.conversations.create).toHaveBeenCalled())
		expect(vi.mocked(api.conversations.create).mock.calls[0]?.[1]).toMatchObject({
			participant_actor_ids: ['agent-coach'],
			initial_message: 'Catch me up on billing',
		})
	})

	it('disables send when the workspace has no agent to route to', async () => {
		const user = userEvent.setup()
		vi.mocked(api.actors.list).mockResolvedValue([] as never)
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		await user.type(screen.getByLabelText(/title/i), 'Catch me up on billing')

		expect(await screen.findByText(/no agent to pick it up yet/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
	})

	it('opens the type menu on / and sets the pill when a row is picked', async () => {
		const user = userEvent.setup()
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		const input = screen.getByLabelText(/title/i)
		await user.type(input, '/bet')

		const listbox = screen.getByRole('listbox', { name: /pick a type/i })
		expect(listbox).toBeInTheDocument()
		await user.click(screen.getByRole('option', { name: /Bet/ }))

		expect(screen.getByText('New bet')).toBeInTheDocument()
		expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
		expect(input).toHaveValue('')
	})

	it('offers loop, agent and trigger in the / menu rather than the chip row', async () => {
		const user = userEvent.setup()
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} />)
		await user.type(screen.getByLabelText(/title/i), '/')

		expect(screen.getByRole('option', { name: /Loop/ })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: /Agent/ })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: /Trigger/ })).toBeInTheDocument()
	})

	it('clears the type pill on Backspace in an empty input', async () => {
		const user = userEvent.setup()
		renderWithWorkspace(
			<CreatePicker open onOpenChange={() => {}} defaultType="object" defaultObjectSubtype="bet" />,
		)
		expect(screen.getByText('New bet')).toBeInTheDocument()
		const input = screen.getByLabelText(/title/i)
		input.focus()
		await user.keyboard('{Backspace}')

		expect(screen.queryByText('New bet')).not.toBeInTheDocument()
		expect(screen.getByRole('radio', { name: 'Bet' })).toBeInTheDocument()
	})

	it('routes the greet card to the Chats zero state', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		renderWithWorkspace(<CreatePicker open onOpenChange={onOpenChange} />)
		await user.click(screen.getByRole('button', { name: /just want to talk/i }))

		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({ to: '/$workspaceId/chats/new' }),
		)
	})

	it('creates an agent, adds workspace membership, and navigates to the agent detail page', async () => {
		const user = userEvent.setup()
		setStoredActor({ id: 'actor-me', name: 'Me', type: 'human', email: null })
		vi.mocked(api.actors.create).mockResolvedValue({
			...COACH,
			id: 'actor-77',
			name: 'Router',
			api_key: 'ank_x',
		} as never)
		const onOpenChange = vi.fn()
		renderWithWorkspace(<CreatePicker open onOpenChange={onOpenChange} defaultType="agent" />)
		await user.type(screen.getByLabelText(/title/i), 'Router')
		await user.click(screen.getByRole('button', { name: /^create agent$/i }))
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
		await user.click(screen.getByRole('button', { name: /^create trigger$/i }))
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

	it('creates a loop object with status "running" and navigates to the loop detail page', async () => {
		const user = userEvent.setup()
		vi.mocked(api.objects.create).mockResolvedValue({
			id: 'loop-5',
			workspaceId: 'ws-1',
			type: 'loop',
			title: 'Support triage',
			content: null,
			status: 'running',
			metadata: null,
			driver: null,
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		})
		const onOpenChange = vi.fn()
		renderWithWorkspace(
			<CreatePicker open onOpenChange={onOpenChange} defaultType="loop" />,
			// Loop status doesn't come from the workspace's per-type status list —
			// this asserts it stays 'running' even when the workspace has no
			// matching entry (or a misleading one) for 'loop'.
			{ settings: { statuses: { bet: ['active'] } } },
		)
		await user.type(screen.getByLabelText(/title/i), 'Support triage')
		await user.click(screen.getByRole('button', { name: /^create loop$/i }))
		await waitFor(() => expect(api.objects.create).toHaveBeenCalled())
		expect(vi.mocked(api.objects.create).mock.calls[0]?.[1]).toMatchObject({
			type: 'loop',
			title: 'Support triage',
			status: 'running',
		})
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		expect(navigateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/loops/$loopId',
				params: expect.objectContaining({ loopId: 'loop-5' }),
			}),
		)
		await waitFor(() => {
			const calls = captureSpy.mock.calls.filter((c) => c[0] === 'object_created')
			expect(calls.length).toBe(1)
			expect(calls[0]?.[1]).toMatchObject({ entity_id: 'loop-5', object_subtype: 'loop' })
		})
	})

	it('leaves the send button disabled until something is typed', async () => {
		renderWithWorkspace(<CreatePicker open onOpenChange={() => {}} defaultType="loop" />)
		expect(screen.getByRole('button', { name: /^create loop$/i })).toBeDisabled()
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
