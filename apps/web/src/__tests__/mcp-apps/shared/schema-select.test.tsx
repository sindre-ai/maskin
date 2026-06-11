import { SchemaSelect } from '@/mcp-apps/shared/schema-select'
import type { WorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

vi.mock('@/mcp-apps/shared/use-workspace-schema', async () => {
	const actual = await vi.importActual<typeof import('@/mcp-apps/shared/use-workspace-schema')>(
		'@/mcp-apps/shared/use-workspace-schema',
	)
	return {
		...actual,
		useWorkspaceSchema: () => ({ schema: null, loading: false, error: null, refresh: vi.fn() }),
	}
})

const schema: WorkspaceSchema = {
	workspace_id: 'ws-1',
	workspace_name: 'Test',
	relationship_types: ['relates_to'],
	types: {
		task: {
			display_name: 'Task',
			statuses: ['todo', 'in_progress', 'done'],
			fields: [
				{ name: 'priority', type: 'enum', required: false, values: ['low', 'med', 'high'] },
				{ name: 'note', type: 'text', required: false },
			],
		},
	},
}

function Harness({
	field,
	objectType = 'task',
	initial,
	overrideSchema = schema,
}: {
	field: string
	objectType?: string
	initial?: string
	overrideSchema?: WorkspaceSchema | null
}) {
	const [value, setValue] = useState<string | undefined>(initial)
	return (
		<SchemaSelect
			objectType={objectType}
			field={field}
			value={value}
			onChange={setValue}
			schemaOverride={overrideSchema}
		/>
	)
}

describe('SchemaSelect', () => {
	it('resolves the special status field against statuses[]', () => {
		render(<Harness field="status" />)
		const trigger = screen.getByRole('combobox', { name: 'Select status' })
		expect(trigger).not.toBeDisabled()
		expect(trigger).toHaveTextContent('Select status')
	})

	it('renders enum field options when opened', () => {
		render(<Harness field="priority" />)
		const trigger = screen.getByRole('combobox', { name: 'Select priority' })
		fireEvent.click(trigger)
		expect(screen.getByRole('option', { name: 'low' })).toBeInTheDocument()
		expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument()
	})

	it('disables and labels unknown fields', () => {
		render(<Harness field="not_in_schema" />)
		const trigger = screen.getByRole('combobox', { name: 'Select not_in_schema' })
		expect(trigger).toBeDisabled()
		expect(trigger).toHaveTextContent('Unknown field: not_in_schema')
	})

	it('disables non-enum fields', () => {
		render(<Harness field="note" />)
		expect(screen.getByRole('combobox', { name: 'Select note' })).toBeDisabled()
	})

	it('shows a loading placeholder while schema is null', () => {
		render(<Harness field="priority" overrideSchema={null} />)
		const trigger = screen.getByRole('combobox', { name: 'Select priority' })
		expect(trigger).toBeDisabled()
	})

	it('marks required + missing as aria-invalid', () => {
		render(
			<SchemaSelect
				objectType="task"
				field="status"
				value=""
				onChange={() => {}}
				required
				schemaOverride={schema}
			/>,
		)
		const trigger = screen.getByRole('combobox', { name: 'Select status' })
		expect(trigger).toHaveAttribute('aria-required', 'true')
		expect(trigger).toHaveAttribute('aria-invalid', 'true')
	})
})
