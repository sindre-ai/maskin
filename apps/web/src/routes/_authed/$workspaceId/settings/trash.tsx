import { SettingsPageTitle } from '@/components/settings/settings-page-title'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useRestoreFromTrash, useTrash } from '@/hooks/use-trash'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/trash')({
	component: TrashPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function formatWhen(iso: string): string {
	return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Settings → Trash. A person restores a row an agent deleted, inside the 30 day window.
 * Behind the trash-restore flag: the delete handlers already keep a restorable copy, but
 * only testers see this screen until it graduates.
 */
function TrashPage() {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag('trash-restore')
	if (!enabled) return null
	return <TrashView workspaceId={workspaceId} />
}

function TrashView({ workspaceId }: { workspaceId: string }) {
	const { data, isLoading, isError } = useTrash(workspaceId)
	const restore = useRestoreFromTrash(workspaceId)
	const [restoringId, setRestoringId] = useState<string | null>(null)
	const [failedId, setFailedId] = useState<string | null>(null)

	const rows = data?.rows ?? []
	const retentionDays = data?.trash_retention_days ?? 30

	const onRestore = (id: string) => {
		setRestoringId(id)
		setFailedId(null)
		restore.mutate(id, {
			onSettled: () => setRestoringId(null),
			onError: () => setFailedId(id),
		})
	}

	return (
		<div className="flex flex-col gap-6">
			<SettingsPageTitle
				title="Trash"
				subtitle={`Deleted items stay here for ${retentionDays} days, then they are removed for good. Restoring puts one back where it was.`}
			/>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : isError ? (
				<p className="text-sm text-destructive">The trash could not be loaded. Try again.</p>
			) : rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nothing has been deleted recently.</p>
			) : (
				<ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
					{rows.map((row) => (
						<li
							key={row.id}
							className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="secondary">{row.kindLabel}</Badge>
									<span className="truncate font-medium">{row.title}</span>
								</div>
								<p className="mt-1 text-sm text-muted-foreground">
									{row.subtitle ? `${row.subtitle} · ` : ''}
									Deleted {formatWhen(row.deletedAt)}
									{row.deletedBy ? ` by ${row.deletedBy.name}` : ''}
								</p>
								<p className="text-xs text-muted-foreground">
									Removed for good on {formatWhen(row.purgeAt)}
								</p>
								{failedId === row.id ? (
									<p className="mt-1 text-xs text-destructive">
										Could not restore this one. Something with the same name or id may exist.
									</p>
								) : null}
							</div>
							<Button
								variant="outline"
								size="sm"
								className="shrink-0"
								disabled={restoringId === row.id}
								onClick={() => onRestore(row.id)}
							>
								{restoringId === row.id ? 'Restoring…' : 'Restore'}
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}
