import {
	NO_AGENT_LINE,
	ScopeEditorSheet,
	agentCountLine,
	countAgents,
	scopeSaveErrorMessage,
} from '@/components/keychain/scope-editor-sheet'
import { ApiError } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const AGENTS = [
	{ id: 'agent-1', name: 'Infra & DevOps' },
	{ id: 'agent-2', name: 'Code Reviewer' },
]

function renderSheet(over: Partial<React.ComponentProps<typeof ScopeEditorSheet>> = {}) {
	const onSave = vi.fn()
	render(
		<ScopeEditorSheet
			open
			onOpenChange={() => {}}
			credentialName="Linear key"
			agents={AGENTS}
			grants={[]}
			saving={false}
			error={null}
			onSave={onSave}
			{...over}
		/>,
	)
	return { onSave }
}

describe('ScopeEditorSheet', () => {
	it('shows the failure line in red inside the sheet and keeps the form usable', () => {
		renderSheet({ error: scopeSaveErrorMessage(new ApiError(500, 'boom')) })
		expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save access. Nothing changed.")
		expect(screen.getByRole('button', { name: 'Save access' })).toBeEnabled()
	})

	it('shows the server message for a 403 instead of the generic line', () => {
		const message =
			'Only the person who saved this key or a workspace admin can change who can use it'
		expect(scopeSaveErrorMessage(new ApiError(403, message))).toBe(message)
		expect(scopeSaveErrorMessage(new ApiError(409, 'conflict'))).toBe(
			"Couldn't save access. Nothing changed.",
		)
		expect(scopeSaveErrorMessage(new TypeError('network'))).toBe(
			"Couldn't save access. Nothing changed.",
		)
	})

	it('shows no alert when there is no error', () => {
		renderSheet()
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})

	it('starts empty with the empty-state line and the new-sessions note', () => {
		renderSheet()
		expect(screen.getByText(NO_AGENT_LINE)).toBeInTheDocument()
		expect(
			screen.getByText(
				'Applies to new sessions. A session already running keeps the key until it ends.',
			),
		).toBeInTheDocument()
	})

	it('starts from the saved grants and counts the ticked agents', async () => {
		const user = userEvent.setup()
		const { onSave } = renderSheet({ grants: [{ kind: 'actor', actorId: 'agent-1' }] })
		expect(screen.getByRole('checkbox', { name: 'Infra & DevOps' })).toBeChecked()
		expect(screen.getByText('Available to 1 agent')).toBeInTheDocument()
		await user.click(screen.getByRole('checkbox', { name: 'Code Reviewer' }))
		expect(screen.getByText('Available to 2 agents')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Save access' }))
		expect(onSave).toHaveBeenCalledWith([
			{ kind: 'actor', actorId: 'agent-1' },
			{ kind: 'actor', actorId: 'agent-2' },
		])
	})

	it('sends a workspace grant for the all-agents row and disables the individual boxes', async () => {
		const user = userEvent.setup()
		const { onSave } = renderSheet({ grants: [{ kind: 'actor', actorId: 'agent-1' }] })
		await user.click(screen.getByRole('checkbox', { name: 'All agents in this workspace' }))
		expect(screen.getByRole('checkbox', { name: 'Infra & DevOps' })).toBeDisabled()
		expect(screen.getByRole('checkbox', { name: 'Code Reviewer' })).toBeDisabled()
		expect(screen.getByText('Available to 2 agents')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Save access' }))
		expect(onSave).toHaveBeenCalledWith([{ kind: 'workspace' }])
	})

	it('saves an empty list when everything is un-ticked', async () => {
		const user = userEvent.setup()
		const { onSave } = renderSheet({ grants: [{ kind: 'actor', actorId: 'agent-1' }] })
		await user.click(screen.getByRole('checkbox', { name: 'Infra & DevOps' }))
		expect(screen.getByText(NO_AGENT_LINE)).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Save access' }))
		expect(onSave).toHaveBeenCalledWith([])
	})

	it('shows a spinner state and disables the controls while saving', () => {
		renderSheet({ saving: true })
		expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled()
		expect(screen.getByRole('checkbox', { name: 'Code Reviewer' })).toBeDisabled()
	})
})

describe('countAgents', () => {
	it('counts only agents, not people or loops', () => {
		expect(
			countAgents(
				[
					{ kind: 'actor', actorId: 'agent-1' },
					{ kind: 'actor', actorId: 'a-person' },
					{ kind: 'loop', loopId: 'loop-1' },
				],
				AGENTS,
			),
		).toBe(1)
		expect(countAgents([{ kind: 'workspace' }], AGENTS)).toBe(2)
		expect(countAgents([], AGENTS)).toBe(0)
	})

	it('says agent once and agents otherwise', () => {
		expect(agentCountLine(1)).toBe('Available to 1 agent')
		expect(agentCountLine(3)).toBe('Available to 3 agents')
	})
})
