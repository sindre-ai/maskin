import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RouteError } from '@/components/shared/route-error'
import { useBriefing } from '@/hooks/use-briefing'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/briefing')({
	component: BriefingPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function BriefingPage() {
	const { workspaceId } = useWorkspace()
	const { data, isLoading, isError, error } = useBriefing(workspaceId)

	return (
		<div className="flex flex-col gap-4">
			<PageHeader />
			<header>
				<h1 className="text-2xl font-semibold leading-tight tracking-tight">Briefing</h1>
				<p className="mt-0.5 text-sm text-muted-foreground">
					The workspace snapshot that opens every agent session — active bets, loops, open insights,
					and recent learnings.
				</p>
			</header>

			{isLoading ? (
				<div className="space-y-4">
					<CardSkeleton />
					<CardSkeleton />
				</div>
			) : isError ? (
				<EmptyState
					title="Couldn't load briefing"
					description={error instanceof Error ? error.message : 'Unknown error'}
				/>
			) : (
				<article className="rounded-md border border-border bg-bg-surface p-4 md:p-6">
					<MarkdownContent content={data?.markdown ?? ''} />
				</article>
			)}
		</div>
	)
}
