import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			board: vi.fn(),
		},
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { LoopPipeline } from '@/components/loops/loop-pipeline'
import type { BoardObjectResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

describe('LoopPipeline', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders nothing when the loop has no child objects', () => {
		const { container } = render(
			<LoopPipeline workspaceId="ws-1" loopId="loop-1" childObjects={[]} />,
			{ wrapper: TestWrapper },
		)

		expect(container).toBeEmptyDOMElement()
		expect(api.objects.board).not.toHaveBeenCalled()
	})

	it('picks the most common child type and renders its status columns', async () => {
		const insights = [
			buildObjectResponse({ id: 'i1', type: 'insight', status: 'new' }),
			buildObjectResponse({ id: 'i2', type: 'insight', status: 'new' }),
			buildObjectResponse({ id: 'i3', type: 'insight', status: 'clustered' }),
			buildObjectResponse({ id: 'b1', type: 'bet', status: 'active' }),
		]
		const board: BoardObjectResponse = {
			columns: [
				{
					id: 'status:new',
					label: 'new',
					value: 'new',
					total: 2,
					objects: [
						buildObjectResponse({
							id: 'i1',
							type: 'insight',
							title: 'First insight',
							status: 'new',
						}),
						buildObjectResponse({
							id: 'i2',
							type: 'insight',
							title: 'Second insight',
							status: 'new',
						}),
					],
				},
				{
					id: 'status:clustered',
					label: 'clustered',
					value: 'clustered',
					total: 1,
					objects: [
						buildObjectResponse({
							id: 'i3',
							type: 'insight',
							title: 'Clustered insight',
							status: 'clustered',
						}),
					],
				},
			],
		}
		vi.mocked(api.objects.board).mockResolvedValue(board)

		render(<LoopPipeline workspaceId="ws-1" loopId="loop-1" childObjects={insights} />, {
			wrapper: TestWrapper,
		})

		expect(await screen.findByText('First insight')).toBeInTheDocument()
		expect(screen.getByText('Second insight')).toBeInTheDocument()
		expect(screen.getByText('Clustered insight')).toBeInTheDocument()
		expect(api.objects.board).toHaveBeenCalledWith('ws-1', {
			type: 'insight',
			groupBy: 'status',
			'metadata.loop_id': 'loop-1',
		})
	})

	it('shows "Nothing here" for a column with a positive total but no returned objects on this page', async () => {
		const board: BoardObjectResponse = {
			columns: [{ id: 'status:new', label: 'new', value: 'new', total: 3, objects: [] }],
		}
		vi.mocked(api.objects.board).mockResolvedValue(board)

		render(
			<LoopPipeline
				workspaceId="ws-1"
				loopId="loop-1"
				childObjects={[buildObjectResponse({ type: 'insight' })]}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(await screen.findByText('Nothing here')).toBeInTheDocument()
	})
})
