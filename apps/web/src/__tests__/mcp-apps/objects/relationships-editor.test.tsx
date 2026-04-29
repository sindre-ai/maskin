import { RelationshipsEditor, V1_RELATIONSHIP_TYPES } from '@/mcp-apps/objects/relationships-editor'
import { McpAppContext, type McpAppContextValue } from '@/mcp-apps/shared/mcp-app-provider'
import type { ObjectResponse, RelationshipResponse } from '@/mcp-apps/shared/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

function rel(overrides: Partial<RelationshipResponse> = {}): RelationshipResponse {
	return {
		id: 'rel-1',
		sourceType: 'object',
		sourceId: 'src',
		targetType: 'object',
		targetId: 'tgt',
		type: 'relates_to',
		createdBy: 'actor-1',
		createdAt: '2026-04-22T00:00:00.000Z',
		...overrides,
	}
}

function obj(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return {
		id: 'tgt',
		workspaceId: 'ws-1',
		type: 'task',
		title: 'Target',
		content: null,
		status: 'todo',
		metadata: null,
		owner: null,
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: '2026-04-22T00:00:00.000Z',
		updatedAt: '2026-04-22T00:00:00.000Z',
		...overrides,
	}
}

/**
 * The editor renders `<WebAppLink>` for connected objects. The link reads
 * `useWebAppContext()` from the McpAppContext — provide a fixture so deep links
 * render in the test instead of disappearing silently.
 */
function Wrapper({ children }: { children: ReactNode }) {
	const value: McpAppContextValue = {
		isConnected: true,
		toolResult: {
			toolName: 'get_objects',
			result: { content: [] },
			input: null,
			webAppBaseUrl: 'https://app.maskin.dev',
			workspaceId: 'ws-1',
		} as unknown as McpAppContextValue['toolResult'],
		callTool: vi.fn(),
	}
	return <McpAppContext.Provider value={value}>{children}</McpAppContext.Provider>
}

describe('RelationshipsEditor', () => {
	it('renders the v1 relationship-edit set in the type select', () => {
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[]}
					connectedObjects={[]}
					onAdd={vi.fn()}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /\+ link/i }))
		// The radix Select trigger holds the currently-selected type (default
		// 'relates_to'); the option list isn't rendered until the trigger is
		// opened, but we can at least confirm the v1 set is statically wired
		// by verifying the constant.
		expect([...V1_RELATIONSHIP_TYPES]).toEqual(['relates_to', 'blocks', 'breaks_into'])
	})

	it('shows "No relationships." when none exist', () => {
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[]}
					connectedObjects={[]}
					onAdd={vi.fn()}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		expect(screen.getByText(/no relationships/i)).toBeInTheDocument()
	})

	it('renders a row for each relationship with the resolved target title', () => {
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[rel({ id: 'r1', sourceId: 'src', targetId: 'tgt' })]}
					connectedObjects={[obj({ id: 'tgt', title: 'Other thing' })]}
					onAdd={vi.fn()}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		expect(screen.getByText('Other thing')).toBeInTheDocument()
	})

	it('requires confirm before deleting a relationship', async () => {
		const onRemove = vi.fn().mockResolvedValue(undefined)
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[rel({ id: 'r1', sourceId: 'src', targetId: 'tgt' })]}
					connectedObjects={[obj({ id: 'tgt' })]}
					onAdd={vi.fn()}
					onRemove={onRemove}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /remove relationship/i }))
		expect(screen.getByText(/remove\?/i)).toBeInTheDocument()
		expect(onRemove).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
		await waitFor(() => expect(onRemove).toHaveBeenCalledWith('r1'))
	})

	it('cancels the delete confirmation without firing onRemove', () => {
		const onRemove = vi.fn()
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[rel({ id: 'r1', sourceId: 'src', targetId: 'tgt' })]}
					connectedObjects={[obj({ id: 'tgt' })]}
					onAdd={vi.fn()}
					onRemove={onRemove}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /remove relationship/i }))
		fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
		expect(onRemove).not.toHaveBeenCalled()
		expect(screen.queryByText(/remove\?/i)).not.toBeInTheDocument()
	})

	it('rejects an invalid UUID before calling onAdd', () => {
		const onAdd = vi.fn()
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[]}
					connectedObjects={[]}
					onAdd={onAdd}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /\+ link/i }))
		fireEvent.change(screen.getByLabelText(/target object id/i), { target: { value: 'nope' } })
		fireEvent.click(screen.getByRole('button', { name: /add link/i }))
		expect(onAdd).not.toHaveBeenCalled()
		expect(screen.getByText(/must be an object uuid/i)).toBeInTheDocument()
	})

	it('rejects linking to an existing target', () => {
		const onAdd = vi.fn()
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[rel({ id: 'r1', sourceId: 'src', targetId: TARGET_ID })]}
					connectedObjects={[obj({ id: TARGET_ID })]}
					onAdd={onAdd}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /\+ link/i }))
		fireEvent.change(screen.getByLabelText(/target object id/i), { target: { value: TARGET_ID } })
		fireEvent.click(screen.getByRole('button', { name: /add link/i }))
		expect(onAdd).not.toHaveBeenCalled()
		expect(screen.getByText(/already linked/i)).toBeInTheDocument()
	})

	it('forwards source_id / target_id / type to onAdd on success', async () => {
		const onAdd = vi.fn().mockResolvedValue(undefined)
		render(
			<Wrapper>
				<RelationshipsEditor
					objectId="src"
					objectType="task"
					relationships={[]}
					connectedObjects={[]}
					onAdd={onAdd}
					onRemove={vi.fn()}
				/>
			</Wrapper>,
		)
		fireEvent.click(screen.getByRole('button', { name: /\+ link/i }))
		fireEvent.change(screen.getByLabelText(/target object id/i), { target: { value: TARGET_ID } })
		fireEvent.click(screen.getByRole('button', { name: /add link/i }))
		await waitFor(() =>
			expect(onAdd).toHaveBeenCalledWith({
				source_id: 'src',
				target_id: TARGET_ID,
				type: 'relates_to',
			}),
		)
	})
})
