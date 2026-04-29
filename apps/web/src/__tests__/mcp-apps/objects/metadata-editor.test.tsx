import { MetadataEditor } from '@/mcp-apps/objects/metadata-editor'
import type { WorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const schema: WorkspaceSchema = {
	workspace_id: 'ws-1',
	workspace_name: 'Test',
	relationship_types: ['relates_to'],
	types: {
		task: {
			display_name: 'Task',
			statuses: ['todo', 'done'],
			fields: [
				{ name: 'priority', type: 'enum', required: false, values: ['low', 'high'] },
				{ name: 'estimate', type: 'number', required: false },
			],
		},
		empty: {
			display_name: 'Empty',
			statuses: [],
			fields: [],
		},
	},
}

vi.mock('@/mcp-apps/shared/use-workspace-schema', async () => {
	const actual = await vi.importActual<typeof import('@/mcp-apps/shared/use-workspace-schema')>(
		'@/mcp-apps/shared/use-workspace-schema',
	)
	return {
		...actual,
		useWorkspaceSchema: () => ({ schema, loading: false, error: null, refresh: vi.fn() }),
	}
})

describe('MetadataEditor', () => {
	it('renders an empty-state when no metadata is set, with an Edit button', () => {
		render(
			<MetadataEditor
				objectId="o1"
				objectType="task"
				workspaceId="ws-1"
				metadata={null}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText(/no metadata set/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument()
	})

	it('lists schema-declared values on the read-only view', () => {
		render(
			<MetadataEditor
				objectId="o1"
				objectType="task"
				workspaceId="ws-1"
				metadata={{ priority: 'high', estimate: 3 }}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText('priority')).toBeInTheDocument()
		expect(screen.getByText('high')).toBeInTheDocument()
		expect(screen.getByText('estimate')).toBeInTheDocument()
		expect(screen.getByText('3')).toBeInTheDocument()
	})

	it('shows a friendly message when the type has no fields', () => {
		render(
			<MetadataEditor
				objectId="o1"
				objectType="empty"
				workspaceId="ws-1"
				metadata={null}
				onSubmit={vi.fn()}
			/>,
		)
		expect(screen.getByText(/no metadata fields defined for empty/i)).toBeInTheDocument()
	})

	it('submits cleaned metadata and exits edit mode', async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined)
		render(
			<MetadataEditor
				objectId="o1"
				objectType="task"
				workspaceId="ws-1"
				metadata={{ estimate: 2 }}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }))
		const estimate = screen.getByLabelText(/estimate/i) as HTMLInputElement
		fireEvent.change(estimate, { target: { value: '5' } })
		fireEvent.click(screen.getByRole('button', { name: /save metadata/i }))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
		expect(onSubmit).toHaveBeenCalledWith({ estimate: 5 })
		// Returned to read-only view after save
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument(),
		)
	})

	it('drops empty-string values so they don\'t overwrite "unset"', async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined)
		render(
			<MetadataEditor
				objectId="o1"
				objectType="task"
				workspaceId="ws-1"
				metadata={{ estimate: 2 }}
				onSubmit={onSubmit}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }))
		const estimate = screen.getByLabelText(/estimate/i) as HTMLInputElement
		fireEvent.change(estimate, { target: { value: '' } })
		fireEvent.click(screen.getByRole('button', { name: /save metadata/i }))
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({}))
	})
})
