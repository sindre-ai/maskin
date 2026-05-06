import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { Board } from '@/components/work-board/board'
import { FilterBar } from '@/components/work-board/filter-bar'
import type { WorkBoardFilters } from '@/components/work-board/filters'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/work/')({
	component: WorkBoardPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>): WorkBoardFilters => {
		const status = typeof search.status === 'string' ? search.status : undefined
		return {
			bet: typeof search.bet === 'string' && search.bet ? search.bet : undefined,
			assignee:
				typeof search.assignee === 'string' && search.assignee ? search.assignee : undefined,
			status: status === 'blocked' || status === 'active' || status === 'all' ? status : undefined,
		}
	},
})

function WorkBoardPage() {
	const navigate = useNavigate()
	const { workspaceId } = useWorkspace()
	const filters = useSearch({ from: '/_authed/$workspaceId/work/' })

	const handleFilterChange = (next: WorkBoardFilters) => {
		// `replace: false` so the back button steps through filter changes —
		// shareable, bookmarkable URLs were the design goal.
		navigate({
			to: '/$workspaceId/work',
			params: { workspaceId },
			search: {
				bet: next.bet,
				assignee: next.assignee,
				status: next.status,
			},
		})
	}

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Work" />
			<FilterBar filters={filters} onChange={handleFilterChange} />
			<div className="flex-1 min-h-0 overflow-y-auto">
				<Board filters={filters} />
			</div>
		</div>
	)
}
