import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { Board } from '@/components/work-board/board'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/work/')({
	component: WorkBoardPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WorkBoardPage() {
	return (
		<div className="flex flex-col flex-1 min-h-0">
			<PageHeader title="Work" />
			<div className="flex-1 min-h-0 overflow-y-auto">
				<Board />
			</div>
		</div>
	)
}
