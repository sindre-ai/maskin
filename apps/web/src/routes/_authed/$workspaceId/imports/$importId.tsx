import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton, Skeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { useImport, useImportAuditRows } from '@/hooks/use-imports'
import type { ImportAuditRow, ImportAuditRowAction, ImportResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/imports/$importId')({
	component: ImportDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const ACTION_LABEL: Record<ImportAuditRowAction, string> = {
	created: 'Created',
	updated: 'Updated',
	skipped: 'Unchanged',
	failed: 'Failed',
}

const ACTION_BADGE_CLASS: Record<ImportAuditRowAction, string> = {
	created: 'bg-success/15 text-success',
	updated: 'bg-amber-500/15 text-amber-600',
	skipped: 'bg-muted text-muted-foreground',
	failed: 'bg-destructive/15 text-destructive',
}

function ImportDetailPage() {
	const { importId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: imp, isLoading } = useImport(importId, workspaceId)
	const { data: auditRows, isLoading: rowsLoading } = useImportAuditRows(importId, workspaceId)

	if (isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-6 w-1/3" />
				<Skeleton className="h-4 w-1/2" />
				<ListSkeleton />
			</div>
		)
	}

	if (!imp) {
		return <EmptyState title="Import not found" description="This import may have been deleted." />
	}

	return (
		<div className="space-y-6">
			<ImportHeader imp={imp} />
			<ImportCounts imp={imp} />
			<section className="space-y-2">
				<h2 className="text-sm font-medium text-foreground">Per-row audit</h2>
				{rowsLoading ? (
					<ListSkeleton />
				) : !auditRows?.length ? (
					<EmptyState
						title="No audit rows"
						description={
							imp.status === 'importing' || imp.status === 'mapping'
								? 'Audit rows are written as the import processes each row. Refresh once it finishes.'
								: 'This import did not produce any per-row audit entries.'
						}
					/>
				) : (
					<div className="space-y-2">
						{auditRows.map((row) => (
							<AuditRowCard key={row.id} row={row} />
						))}
					</div>
				)}
			</section>
		</div>
	)
}

function ImportHeader({ imp }: { imp: ImportResponse }) {
	return (
		<header className="space-y-1">
			<h1 className="text-lg font-semibold text-foreground">{imp.fileName}</h1>
			<p className="text-xs text-muted-foreground">
				{imp.fileType.toUpperCase()} · {imp.totalRows ?? 0} rows · status {imp.status}
				{imp.completedAt && (
					<>
						{' · completed '}
						<RelativeTime date={imp.completedAt} />
					</>
				)}
			</p>
		</header>
	)
}

function ImportCounts({ imp }: { imp: ImportResponse }) {
	return (
		<div className="grid grid-cols-2 md:grid-cols-4 gap-2">
			<CountTile label="Created" value={imp.successCount} tone="success" />
			<CountTile label="Updated" value={imp.updatedCount} tone="amber" />
			<CountTile label="Unchanged" value={imp.skippedCount} tone="muted" />
			<CountTile label="Failed" value={imp.errorCount} tone="destructive" />
		</div>
	)
}

function CountTile({
	label,
	value,
	tone,
}: {
	label: string
	value: number
	tone: 'success' | 'amber' | 'muted' | 'destructive'
}) {
	const toneClass = {
		success: 'text-success',
		amber: 'text-amber-600',
		muted: 'text-muted-foreground',
		destructive: 'text-destructive',
	}[tone]
	return (
		<div className="rounded-lg border border-border bg-card p-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className={`text-xl font-semibold ${toneClass}`}>{value}</p>
		</div>
	)
}

function AuditRowCard({ row }: { row: ImportAuditRow }) {
	const badgeClass = ACTION_BADGE_CLASS[row.action]
	const label = ACTION_LABEL[row.action]
	return (
		<div
			data-testid="audit-row"
			data-action={row.action}
			className="rounded-lg border border-border bg-card p-3"
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${badgeClass}`}>
						{label}
					</span>
					<p className="text-xs text-muted-foreground">Row {row.rowIndex + 1}</p>
				</div>
				{row.objectId && (
					<p className="text-[11px] text-muted-foreground/70 font-mono truncate max-w-[8rem]">
						{row.objectId.slice(0, 8)}
					</p>
				)}
			</div>
			{row.action === 'updated' && row.changedColumns.length > 0 && (
				<dl className="mt-2 space-y-1">
					{row.changedColumns.map((col) => (
						<div
							key={col}
							className="grid grid-cols-[auto_1fr_auto_1fr] items-baseline gap-2 text-xs"
						>
							<dt className="font-medium text-foreground">{col}</dt>
							<dd
								className="text-muted-foreground truncate"
								title={formatValue(row.oldValues[col])}
							>
								{formatValue(row.oldValues[col])}
							</dd>
							<span aria-hidden className="text-muted-foreground/60">
								→
							</span>
							<dd className="text-foreground truncate" title={formatValue(row.newValues[col])}>
								{formatValue(row.newValues[col])}
							</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	)
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return '—'
	if (typeof v === 'string') return v || '—'
	if (typeof v === 'number' || typeof v === 'boolean') return String(v)
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}
