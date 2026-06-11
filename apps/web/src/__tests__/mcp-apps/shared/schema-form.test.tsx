import { SchemaForm } from '@/mcp-apps/shared/schema-form'
import type { WorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
			statuses: ['todo', 'done'],
			fields: [
				{ name: 'priority', type: 'enum', required: true, values: ['low', 'high'] },
				{ name: 'count', type: 'number', required: false },
				{ name: 'enabled', type: 'boolean', required: false },
				{ name: 'tag', type: 'text', required: true },
			],
		},
		empty: {
			display_name: 'Empty',
			statuses: [],
			fields: [],
		},
	},
}

function Harness(
	props: Partial<React.ComponentProps<typeof SchemaForm>> & { initial?: Record<string, unknown> },
) {
	const [values, setValues] = useState<Record<string, unknown>>(props.initial ?? {})
	return (
		<SchemaForm
			objectType="task"
			values={values}
			onChange={setValues}
			schemaOverride={schema}
			{...props}
		/>
	)
}

describe('SchemaForm', () => {
	it('renders an input for each declared field', () => {
		render(<Harness />)
		expect(screen.getByLabelText(/priority/i)).toBeInTheDocument()
		expect(screen.getByLabelText(/count/i)).toBeInTheDocument()
		expect(screen.getByLabelText(/enabled/i)).toBeInTheDocument()
		expect(screen.getByLabelText(/tag/i)).toBeInTheDocument()
	})

	it('respects fieldNames to filter the rendered set', () => {
		render(<Harness fieldNames={['tag']} />)
		expect(screen.getByLabelText(/tag/i)).toBeInTheDocument()
		expect(screen.queryByLabelText(/priority/i)).not.toBeInTheDocument()
	})

	it('shows a friendly message when type has no fields', () => {
		render(<Harness objectType="empty" />)
		expect(screen.getByText(/no editable metadata fields/i)).toBeInTheDocument()
	})

	it('shows unknown-type message when objectType is missing from schema', () => {
		render(<Harness objectType="alien" />)
		expect(screen.getByText(/unknown object type: alien/i)).toBeInTheDocument()
	})

	it('emits onChange with text edits', () => {
		const onChange = vi.fn()
		render(<SchemaForm objectType="task" values={{}} onChange={onChange} schemaOverride={schema} />)
		fireEvent.change(screen.getByLabelText(/tag/i), { target: { value: 'urgent' } })
		expect(onChange).toHaveBeenCalledWith({ tag: 'urgent' })
	})

	it('coerces number inputs to numbers', () => {
		const onChange = vi.fn()
		render(<SchemaForm objectType="task" values={{}} onChange={onChange} schemaOverride={schema} />)
		fireEvent.change(screen.getByLabelText(/count/i), { target: { value: '42' } })
		expect(onChange).toHaveBeenLastCalledWith({ count: 42 })
	})

	it('renders boolean field as a switch and emits true/false', () => {
		const onChange = vi.fn()
		render(
			<SchemaForm
				objectType="task"
				values={{ enabled: false }}
				onChange={onChange}
				schemaOverride={schema}
			/>,
		)
		const sw = screen.getByRole('switch', { name: /enabled/i })
		fireEvent.click(sw)
		expect(onChange).toHaveBeenLastCalledWith({ enabled: true })
	})

	it('blocks submit and shows inline errors when required fields are empty', async () => {
		const onSubmit = vi.fn()
		render(<Harness onSubmit={onSubmit} />)
		fireEvent.click(screen.getByRole('button', { name: /save/i }))
		await waitFor(() => {
			expect(screen.getByText(/priority is required/i)).toBeInTheDocument()
		})
		expect(screen.getByText(/tag is required/i)).toBeInTheDocument()
		expect(onSubmit).not.toHaveBeenCalled()
	})
})
