import { PageHeader } from '@/components/layout/page-header'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TasksBoard } from '@/components/tasks/tasks-board'
import { Button } from '@/components/ui/button'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

export const Route = createFileRoute('/_authed/$workspaceId/tasks/')({
	component: TasksPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TasksPage() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()

	const { data: tasks = [], isLoading: tasksLoading } = useObjects(workspaceId, { type: 'task' })
	const { data: bets = [] } = useObjects(workspaceId, { type: 'bet' })

	const handleNewTask = () => {
		navigate({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId, objectId: crypto.randomUUID() },
		})
	}

	return (
		<>
			<PageHeader
				title="Tasks"
				actions={
					<Button size="sm" variant="outline" onClick={handleNewTask} className="gap-1.5">
						<Plus size={13} />
						New task
					</Button>
				}
			/>

			{tasksLoading ? <ListSkeleton /> : <TasksBoard tasks={tasks} bets={bets} />}
		</>
	)
}
