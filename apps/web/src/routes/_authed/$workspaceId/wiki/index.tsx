import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { WikiLayout } from '@/components/wiki/wiki-layout'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useObjects } from '@/hooks/use-objects'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/wiki/')({
	component: WikiLandingPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function WikiLandingPage() {
	const { workspaceId } = useWorkspace()
	const enabled = useEnabledModules()

	if (!enabled.includes('knowledge')) {
		return (
			<>
				<PageHeader />
				<EmptyState
					title="Knowledge extension is not enabled"
					description="Enable the Knowledge module on this workspace to start a shared, agent-curated wiki. Run create_extension({id:'knowledge'}) via MCP."
				/>
			</>
		)
	}

	return <WikiLanding workspaceId={workspaceId} />
}

function WikiLanding({ workspaceId }: { workspaceId: string }) {
	const { data: articles } = useObjects(workspaceId, { type: 'knowledge' })
	const recent = (articles ?? [])
		.slice()
		.sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		)
		.slice(0, 5)

	return (
		<WikiLayout workspaceId={workspaceId} articles={articles ?? []}>
			<div className="max-w-2xl mx-auto pt-12">
				<h1 className="text-2xl font-semibold mb-2">Wiki</h1>
				<p className="text-sm text-muted-foreground mb-8">
					Durable knowledge for this workspace. Click any article in the sidebar to start reading,
					or pick from the most recently updated below.
				</p>
				{recent.length === 0 ? (
					<EmptyState
						title="No articles yet"
						description="The Knowledge Curator will start proposing articles after sessions complete. You can also create one manually."
					/>
				) : (
					<div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
						{recent.map((article) => (
							<Link
								key={article.id}
								to="/$workspaceId/wiki/$articleId"
								params={{ workspaceId, articleId: article.id }}
								className="flex flex-col gap-1 px-4 py-3 hover:bg-bg-hover transition-colors duration-150"
							>
								<span className="text-sm font-medium text-foreground truncate">
									{article.title || 'Untitled'}
								</span>
								{typeof article.metadata === 'object' &&
									article.metadata !== null &&
									'summary' in article.metadata && (
										<span className="text-xs text-muted-foreground line-clamp-2">
											{String((article.metadata as { summary?: string }).summary ?? '')}
										</span>
									)}
							</Link>
						))}
					</div>
				)}
			</div>
		</WikiLayout>
	)
}
