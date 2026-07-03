import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { useImports } from '@/hooks/use-imports'
import type { ImportListItem } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { FileText } from 'lucide-react'

export const Route = createFileRoute('/_authed/$workspaceId/imports/')({
	component: ImportsIndexPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const STATUS_DOT_CLASS: Record<string, string> = {
	completed: 'bg-success',
	importing: 'bg-amber-500 animate-pulse',
	mapping: 'bg-zinc-500',
	uploading: 'bg-zinc-500',
	failed: 'bg-destructive',
}

function ImportsIndexPage() {
	const { workspaceId } = useWorkspace()
	const { data: imports, isLoading } = useImports(workspaceId)

	if (isLoading) return <ListSkeleton />
	if (!imports?.length) {
		return (
			<EmptyState
				title="No imports yet"
				description="Bulk imports show up here once you upload a file from the Objects toolbar. Each row shows the file, totals, and what was created vs updated."
			/>
		)
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground mb-3">
				A history of every bulk import, newest first. Click through for the per-row audit of what
				was created vs updated.
			</p>
			<div className="space-y-2">
				{imports.map((imp) => (
					<ImportRow key={imp.id} imp={imp} workspaceId={workspaceId} />
				))}
			</div>
		</div>
	)
}

function ImportRow({ imp, workspaceId }: { imp: ImportListItem; workspaceId: string }) {
	const dotClass = STATUS_DOT_CLASS[imp.status] ?? 'bg-zinc-500'
	const ts = imp.completedAt ?? imp.createdAt
	return (
		<Link
			to="/$workspaceId/imports/$importId"
			params={{ workspaceId, importId: imp.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
		>
			<span className={`h-3 w-3 shrink-0 rounded-full ${dotClass}`} aria-label={imp.status} />
			<FileText size={15} className="shrink-0 text-muted-foreground" />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-sm font-medium text-foreground truncate">{imp.fileName}</p>
					<span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded uppercase">
						{imp.fileType}
					</span>
				</div>
				<p className="text-xs text-muted-foreground truncate">
					<ImportCountsLine imp={imp} />
				</p>
				<p className="text-xs text-muted-foreground/60 mt-0.5">
					{imp.status}
					{ts && (
						<>
							{' · '}
							<RelativeTime date={ts} />
						</>
					)}
				</p>
			</div>
		</Link>
	)
}

function ImportCountsLine({ imp }: { imp: ImportListItem }) {
	const parts: string[] = []
	if (imp.successCount > 0) parts.push(`${imp.successCount} created`)
	if (imp.updatedCount > 0) parts.push(`${imp.updatedCount} updated`)
	if (imp.skippedCount > 0) parts.push(`${imp.skippedCount} unchanged`)
	if (imp.errorCount > 0) parts.push(`${imp.errorCount} failed`)
	if (parts.length === 0 && imp.totalRows != null) parts.push(`${imp.totalRows} rows`)
	return <>{parts.join(' · ') || '—'}</>
}
