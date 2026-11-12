import { ViewerStage } from '@/components/files/viewer-stage'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { useFile } from '@/hooks/use-files'
import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'

/**
 * A briefing on the flow page: the same viewer the file page uses (a deck is fitted to the box
 * and paged), in a tall box instead of the auto-height frame custom views use, which shrinks a
 * deck to a strip. "Open full page" goes to the file page for annotations and comments.
 */
export function LoopBriefingStage({
	workspaceId,
	fileId,
}: {
	workspaceId: string
	fileId: string
}) {
	const { data: file, isLoading, isError } = useFile(workspaceId, fileId)
	if (isLoading) return <Skeleton className="h-[60vh] w-full" />
	if (isError || !file) {
		return (
			<p role="alert" className="text-sm text-muted-foreground">
				This briefing can't be shown right now.
			</p>
		)
	}
	return (
		<div className="min-w-0">
			<div className="mb-3 flex items-center gap-2.5 px-1">
				<h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
					{file.name.replace(/\.html?$/i, '')}
				</h2>
				<Link
					to="/$workspaceId/files/$fileId"
					params={{ workspaceId, fileId }}
					className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					Open full page <ExternalLink size={12} />
				</Link>
			</div>
			<div
				data-testid="loop-briefing-stage"
				className="relative flex h-[max(24rem,calc(100dvh-22rem))] min-h-0 overflow-hidden rounded-xl border border-border"
			>
				<ViewerStage file={file} />
			</div>
		</div>
	)
}
