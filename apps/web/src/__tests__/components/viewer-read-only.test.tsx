import { CommentInput } from '@/components/activity/comment-input'
import { AuxiliaryActionMenu } from '@/components/objects/auxiliary-action-menu'
import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { OwnerSelect, StatusSelect } from '@/components/objects/property-selects'
import { DecisionOptions } from '@/components/shared/decision-option-card'
import { NewMenu } from '@/components/shared/new-menu'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../factories'
import { createWorkspaceWrapper } from '../setup'

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [{ value: 'insight', label: 'Insight' }],
}))

const viewer = () => createWorkspaceWrapper({ role: 'viewer' })
const member = () => createWorkspaceWrapper({ role: 'member' })

const members = [{ actorId: 'a-1', role: 'member', joinedAt: null, name: 'Alice', type: 'human' }]

describe('viewer fixture: write controls are disabled, not hidden', () => {
	it('disables the status and driver pickers', () => {
		render(
			<>
				<StatusSelect current="todo" options={['todo', 'done']} onChange={vi.fn()} />
				<OwnerSelect members={members} currentOwnerId="a-1" onChange={vi.fn()} />
			</>,
			{ wrapper: viewer() },
		)
		const [status, owner] = screen.getAllByRole('combobox')
		expect(status).toBeDisabled()
		expect(owner).toBeDisabled()
	})

	it('shows the comment box switched off', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />, { wrapper: viewer() })
		const box = screen.getByRole('textbox', { name: 'Comment' })
		expect(box).toBeDisabled()
		expect(box).toHaveAttribute('placeholder', 'Viewers can read but not change this')
	})

	it('disables the New button', () => {
		render(<NewMenu onNewChat={vi.fn()} primaryKind="object" />, { wrapper: viewer() })
		expect(screen.getByRole('button', { name: 'New object' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeDisabled()
	})

	it('disables the decision answer buttons', () => {
		render(
			<DecisionOptions
				options={[
					{ id: 'go', label: 'Go', recommended: true, consequences: ['a', 'b'] },
					{ id: 'hold', label: 'Hold', consequences: ['a', 'b'] },
				]}
				pendingId={null}
				onChoose={vi.fn()}
			/>,
			{ wrapper: viewer() },
		)
		expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Hold' })).toBeDisabled()
	})

	it('disables the bulk status, driver, archive and delete controls but keeps copy and clear', () => {
		render(
			<BulkActionBar
				selectedCount={2}
				statusOptions={[{ value: 'todo', label: 'Todo' }]}
				ownerOptions={[{ id: 'a-1', name: 'Alice' }]}
				onStatusChange={vi.fn()}
				onOwnerChange={vi.fn()}
				onArchive={vi.fn()}
				onDelete={vi.fn()}
				onCopyLink={vi.fn()}
				onClear={vi.fn()}
			/>,
			{ wrapper: viewer() },
		)
		expect(screen.getByRole('combobox', { name: 'Set status' })).toBeDisabled()
		expect(screen.getByRole('combobox', { name: 'Set driver' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Archive selected' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Clear selection' })).toBeEnabled()
	})

	it('disables archive and delete in the object menu but leaves subscribe open', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		render(
			<AuxiliaryActionMenu
				object={buildObjectResponse({ type: 'bet', status: 'active' })}
				onDeleteRequest={vi.fn()}
				onArchiveRequest={vi.fn()}
				workspaceId="ws-1"
			/>,
			{ wrapper: viewer() },
		)
		await user.click(screen.getByRole('button', { name: /more actions/i }))
		expect(await screen.findByRole('menuitem', { name: /archive/i })).toHaveAttribute(
			'data-disabled',
		)
		expect(screen.getByRole('menuitem', { name: /delete/i })).toHaveAttribute('data-disabled')
		expect(screen.getByRole('menuitem', { name: /subscribe/i })).not.toHaveAttribute(
			'data-disabled',
		)
	})
})

describe('member fixture: nothing changes', () => {
	it('keeps the pickers, New button and decision buttons enabled', () => {
		render(
			<>
				<StatusSelect current="todo" options={['todo', 'done']} onChange={vi.fn()} />
				<OwnerSelect members={members} currentOwnerId="a-1" onChange={vi.fn()} />
				<NewMenu onNewChat={vi.fn()} primaryKind="object" />
				<DecisionOptions
					options={[{ id: 'go', label: 'Go', recommended: true, consequences: ['a', 'b'] }]}
					pendingId={null}
					onChoose={vi.fn()}
				/>
			</>,
			{ wrapper: member() },
		)
		for (const picker of screen.getAllByRole('combobox')) expect(picker).toBeEnabled()
		expect(screen.getByRole('button', { name: 'New object' })).toBeEnabled()
		expect(screen.getByRole('button', { name: 'Go' })).toBeEnabled()
	})
})
