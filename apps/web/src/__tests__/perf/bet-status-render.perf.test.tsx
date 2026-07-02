/**
 * Render-time perf harness for the bet-status guardrail.
 *
 * Gated on `RUN_PERF=1` so it does not run in the normal suite. Run with:
 *
 *   RUN_PERF=1 pnpm --filter @maskin/web vitest run \
 *     src/__tests__/perf/bet-status-render.perf.test.tsx --reporter=verbose
 *
 * Two surfaces, measured with `performance.now()` around a full jsdom render
 * (via @testing-library/react). Warmup + 50 samples per surface. Reports p50
 * and p95 to stdout for the bet-page-status guardrail (Δp95 ≤ +100ms).
 */
import { getStaticColumns } from '@/components/objects/data-table/columns'
import { ObjectDocumentView } from '@/components/objects/object-document'
import type { ObjectResponse } from '@/lib/api'
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { render } from '@testing-library/react'
import { buildActorResponse, buildObjectResponse } from '../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => <div data-testid="object-activity" />,
}))

vi.mock('@/components/shared/subscribe-toggle', () => ({
	SubscribeToggle: () => <div data-testid="subscribe-toggle" />,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/linked-objects', () => ({
	LinkedObjects: () => <div data-testid="linked-objects" />,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => <div data-testid="object-files" />,
}))

function TestTable({
	data,
	columns,
}: {
	data: ObjectResponse[]
	columns: ColumnDef<ObjectResponse>[]
}) {
	const table = useReactTable({
		data,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getRowId: (row) => row.id,
	})
	return (
		<table>
			<tbody>
				{table.getRowModel().rows.map((row) => (
					<tr key={row.id}>
						{row.getVisibleCells().map((cell) => (
							<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	)
}

function quantile(samples: number[], q: number): number {
	const sorted = [...samples].sort((a, b) => a - b)
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
	return sorted[idx]
}

const SAMPLES = Number(process.env.PERF_SAMPLES ?? '50')
const WARMUP = Number(process.env.PERF_WARMUP ?? '5')
const OVERVIEW_ROWS = Number(process.env.PERF_OVERVIEW_ROWS ?? '200')
const RUN = process.env.RUN_PERF === '1'

function formatLine(surface: string, samples: number[]): string {
	const p50 = quantile(samples, 0.5)
	const p95 = quantile(samples, 0.95)
	const min = samples.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)
	const max = samples.reduce((a, b) => Math.max(a, b), 0)
	return `[PERF] ${surface} n=${samples.length} min=${min.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`
}

const RUN_TIMEOUT_MS = 120_000

describe.skipIf(!RUN)('bet-status render-time p95 harness', () => {
	it('objects overview — 200 bet rows via getStaticColumns', { timeout: RUN_TIMEOUT_MS }, () => {
		const columns = getStaticColumns({ workspaceId: 'ws-1' })
		const rows: ObjectResponse[] = []
		for (let i = 0; i < OVERVIEW_ROWS; i++) {
			rows.push(
				buildObjectResponse({
					id: `bet-${i}`,
					type: 'bet',
					title: `Bet ${i}`,
					status: i % 3 === 0 ? 'proposed' : i % 3 === 1 ? 'active' : 'done',
					driver: i % 2 === 0 ? 'actor-1' : null,
					createdBy: 'actor-1',
					updatedAt: new Date(Date.now() - i * 3600_000).toISOString(),
					createdAt: new Date(Date.now() - i * 7200_000).toISOString(),
				}),
			)
		}

		const samples: number[] = []
		for (let i = 0; i < WARMUP + SAMPLES; i++) {
			const start = performance.now()
			const { unmount } = render(<TestTable data={rows} columns={columns} />)
			const end = performance.now()
			if (i >= WARMUP) samples.push(end - start)
			unmount()
		}

		// eslint-disable-next-line no-console
		console.log(formatLine('objects-overview', samples))
	})

	it('bet detail header — ObjectDocumentView full mount', { timeout: RUN_TIMEOUT_MS }, () => {
		const object = buildObjectResponse({
			id: 'bet-heavy',
			type: 'bet',
			title: 'Heavy Bet',
			status: 'active',
			content: '# Heading\n\nSome body text here.',
			driver: 'actor-1',
		})
		const creator = buildActorResponse({ name: 'Author' })

		const samples: number[] = []
		for (let i = 0; i < WARMUP + SAMPLES; i++) {
			const start = performance.now()
			const { unmount } = render(
				<ObjectDocumentView
					workspaceId="ws-1"
					statuses={['proposed', 'active', 'done']}
					onUpdateTitle={() => {}}
					onUpdateContent={() => {}}
					onUpdateStatus={() => {}}
					onUpdateDriver={() => {}}
					onDelete={() => {}}
					object={object}
					creator={creator}
				/>,
			)
			const end = performance.now()
			if (i >= WARMUP) samples.push(end - start)
			unmount()
		}

		// eslint-disable-next-line no-console
		console.log(formatLine('bet-detail-header', samples))
	})
})
