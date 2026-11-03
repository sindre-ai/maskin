import { AgentInstructionsSection } from '@/components/agents/agent-instructions-section'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const updateMutate = vi.fn()
let updatePending = false

vi.mock('@/hooks/use-actors', () => ({
	useUpdateActor: () => ({ mutate: updateMutate, isPending: updatePending }),
}))

vi.mock('sonner', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}))

describe('AgentInstructionsSection', () => {
	beforeEach(() => {
		updateMutate.mockReset()
		updatePending = false
	})

	it('renders the current system prompt with an Edit affordance', () => {
		const agent = buildActorResponse({
			id: 'agent-instr',
			type: 'agent',
			name: 'Planner',
			system_prompt: 'You are Planner. Shape the next bet.',
		})
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByRole('heading', { name: 'Instructions', level: 2 })).toBeInTheDocument()
		expect(screen.getByText('system prompt')).toBeInTheDocument()
		expect(screen.getByText('You are Planner. Shape the next bet.')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
	})

	it('falls back to a placeholder when no prompt is set', () => {
		const agent = buildActorResponse({ system_prompt: null, type: 'agent' })
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		expect(screen.getByText('No instructions set yet.')).toBeInTheDocument()
	})

	it('opens the modal, shows the EDITED badge on change, saves through useUpdateActor, and closes', async () => {
		const agent = buildActorResponse({
			id: 'agent-save',
			type: 'agent',
			name: 'Planner',
			system_prompt: 'Original prompt.',
		})
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
		const dialog = await screen.findByRole('dialog')
		const scope = within(dialog)

		// Warning copy matches the DoD verbatim.
		expect(
			scope.getByText('Running sessions finish on the old prompt. New sessions pick this up.'),
		).toBeInTheDocument()

		// The badge reports unsaved changes — there is no stored default prompt to
		// diff against, so it does not claim "edited away from default".
		expect(scope.queryByText(/unsaved/i)).not.toBeInTheDocument()

		const textarea = scope.getByLabelText('System prompt') as HTMLTextAreaElement
		expect(textarea.value).toBe('Original prompt.')

		await userEvent.clear(textarea)
		await userEvent.type(textarea, 'New prompt.')

		expect(scope.getByText(/unsaved/i)).toBeInTheDocument()

		let savedArgs: { id: string; data: { system_prompt: string } } | undefined
		let savedHandlers: { onSuccess?: () => void; onError?: () => void } | undefined
		updateMutate.mockImplementation(
			(args: { id: string; data: { system_prompt: string } }, handlers) => {
				savedArgs = args
				savedHandlers = handlers
			},
		)

		await userEvent.click(scope.getByRole('button', { name: 'Save' }))
		expect(savedArgs).toEqual({ id: 'agent-save', data: { system_prompt: 'New prompt.' } })

		// Modal closes after the mutation resolves.
		await act(async () => {
			savedHandlers?.onSuccess?.()
		})
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
	})

	it('Revert changes restores the draft to the saved prompt without saving', async () => {
		const agent = buildActorResponse({
			id: 'agent-reset',
			type: 'agent',
			system_prompt: 'Baseline prompt.',
		})
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
		const dialog = await screen.findByRole('dialog')
		const scope = within(dialog)
		const textarea = scope.getByLabelText('System prompt') as HTMLTextAreaElement

		await userEvent.clear(textarea)
		await userEvent.type(textarea, 'Local edit that never gets saved.')
		expect(scope.getByText(/unsaved/i)).toBeInTheDocument()

		await userEvent.click(scope.getByRole('button', { name: /revert changes/i }))
		expect(textarea.value).toBe('Baseline prompt.')
		expect(scope.queryByText(/unsaved/i)).not.toBeInTheDocument()
		expect(updateMutate).not.toHaveBeenCalled()
		// Modal stays open after reset.
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})

	it('Cancel discards local edits and closes the modal without saving', async () => {
		const agent = buildActorResponse({
			id: 'agent-cancel',
			type: 'agent',
			system_prompt: 'Kept prompt.',
		})
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
		const dialog = await screen.findByRole('dialog')
		const scope = within(dialog)
		const textarea = scope.getByLabelText('System prompt') as HTMLTextAreaElement

		await userEvent.type(textarea, ' Extra text.')
		await userEvent.click(scope.getByRole('button', { name: 'Cancel' }))

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		expect(updateMutate).not.toHaveBeenCalled()
		// Section still shows the untouched saved value.
		expect(screen.getByText('Kept prompt.')).toBeInTheDocument()
	})

	// Mockup 3089 — the meta line beside the "running sessions" notice.
	it('shows a paragraph/word count for the draft and keeps it live while typing', async () => {
		const agent = buildActorResponse({
			id: 'agent-meta',
			type: 'agent',
			system_prompt: 'One line.',
		})
		render(<AgentInstructionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
		const scope = within(await screen.findByRole('dialog'))

		expect(scope.getByText('1 paragraph · 2 words')).toBeInTheDocument()

		const textarea = scope.getByLabelText('System prompt') as HTMLTextAreaElement
		await userEvent.type(textarea, ' Two.')
		expect(scope.getByText('1 paragraph · 3 words')).toBeInTheDocument()
	})
})
