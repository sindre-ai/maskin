import {
	__resetSchemaCacheForTests,
	useWorkspaceSchema,
} from '@/mcp-apps/shared/use-workspace-schema'
import { act, render, screen, waitFor } from '@testing-library/react'

const callTool = vi.fn()
const useToolResult = vi.fn(() => ({ workspaceId: 'ws-1' }))

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useCallTool: () => callTool,
	useToolResult: () => useToolResult(),
}))

function makeSchemaResponse(workspaceId = 'ws-1') {
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					workspace_id: workspaceId,
					workspace_name: 'Test',
					relationship_types: ['relates_to'],
					types: {
						task: {
							display_name: 'Task',
							statuses: ['todo', 'done'],
							fields: [
								{
									name: 'priority',
									type: 'enum',
									required: false,
									values: ['low', 'high'],
								},
							],
						},
					},
				}),
			},
		],
	}
}

interface ProbeProps {
	workspaceId?: string
	exposeRefresh?: (refresh: () => Promise<void>) => void
}

function Probe({ workspaceId, exposeRefresh }: ProbeProps) {
	const { schema, loading, error, refresh } = useWorkspaceSchema(workspaceId)
	exposeRefresh?.(refresh)
	if (loading) return <p>loading</p>
	if (error) return <p>err:{error}</p>
	if (!schema) return <p>idle</p>
	return (
		<p>
			{schema.workspace_id}/{Object.keys(schema.types).join(',')}
		</p>
	)
}

describe('useWorkspaceSchema', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResult.mockReset()
		useToolResult.mockReturnValue({ workspaceId: 'ws-1' })
	})

	it('fetches and exposes the schema for the workspace', async () => {
		callTool.mockResolvedValueOnce(makeSchemaResponse())
		render(<Probe />)
		await waitFor(() => {
			expect(screen.getByText('ws-1/task')).toBeInTheDocument()
		})
		expect(callTool).toHaveBeenCalledTimes(1)
		expect(callTool).toHaveBeenCalledWith('get_workspace_schema', {})
	})

	it('caches by workspaceId and avoids a second fetch', async () => {
		callTool.mockResolvedValue(makeSchemaResponse())
		const { unmount } = render(<Probe />)
		await waitFor(() => screen.getByText('ws-1/task'))
		unmount()
		render(<Probe />)
		await waitFor(() => screen.getByText('ws-1/task'))
		expect(callTool).toHaveBeenCalledTimes(1)
	})

	it('passes through an explicit workspace_id arg when supplied', async () => {
		callTool.mockResolvedValueOnce(makeSchemaResponse('ws-2'))
		render(<Probe workspaceId="ws-2" />)
		await waitFor(() => screen.getByText('ws-2/task'))
		expect(callTool).toHaveBeenCalledWith('get_workspace_schema', { workspace_id: 'ws-2' })
	})

	it('surfaces errors from invalid responses', async () => {
		callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] })
		render(<Probe />)
		await waitFor(() => {
			expect(screen.getByText(/^err:/)).toBeInTheDocument()
		})
	})

	it('refresh() bypasses the cache and refetches', async () => {
		callTool.mockResolvedValue(makeSchemaResponse())
		let refresh: (() => Promise<void>) | null = null
		render(
			<Probe
				exposeRefresh={(r) => {
					refresh = r
				}}
			/>,
		)
		await waitFor(() => screen.getByText('ws-1/task'))
		expect(callTool).toHaveBeenCalledTimes(1)
		await act(async () => {
			await refresh?.()
		})
		expect(callTool).toHaveBeenCalledTimes(2)
	})
})
