import { McpTag } from '@/components/integrations/drive/mcp-tag'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { useDriveWatches, useStopDriveWatch } from '@/hooks/use-integrations'
import type { DriveWatch } from '@/lib/api'
import { DRIVE_COPY } from '@/lib/drive-copy'
import { folderDisplayPath, truncatePathAtSeparator } from '@/lib/drive-watches'
import { useWorkspace } from '@/lib/workspace-context'
import { Folder } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

/** Folder watches on the Drive detail page: read and stop only. Adding a watch
 *  stays in an agent's trigger settings. Every value shown comes from the watch
 *  entry or the trigger store; a segment with no source is left out. */
export function FolderWatches({
	nameForAccount,
}: {
	/** The human a Google account belongs to, as the page already names them. */
	nameForAccount: (account: string) => string
}) {
	const { workspaceId } = useWorkspace()
	const { data: watches, isLoading, isError, refetch } = useDriveWatches(workspaceId)
	const stop = useStopDriveWatch(workspaceId)

	return (
		<section
			aria-labelledby="folder-watches-label"
			className="space-y-2"
			data-testid="folder-watches"
		>
			<h3 id="folder-watches-label" className="text-sm font-medium text-foreground">
				{DRIVE_COPY.foldersLabel}
			</h3>
			{isLoading ? (
				<div data-testid="folder-watches-loading">
					<ListSkeleton rows={2} />
				</div>
			) : isError || !watches ? (
				<div
					role="alert"
					className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-surface p-3 text-sm text-muted-foreground"
				>
					{DRIVE_COPY.foldersError}
					<Button size="sm" variant="outline" onClick={() => refetch()}>
						Retry
					</Button>
				</div>
			) : watches.length === 0 ? (
				<div
					className="rounded-md border border-dashed border-border"
					data-testid="folder-watches-empty"
				>
					<EmptyState
						className="py-8"
						title={DRIVE_COPY.foldersEmptyTitle}
						description={DRIVE_COPY.foldersEmptyDescription}
					/>
				</div>
			) : (
				<ul
					className="space-y-2"
					aria-label={DRIVE_COPY.foldersLabel}
					data-testid="folder-watch-list"
				>
					{watches.map((watch) => (
						<WatchRow
							key={`${watch.integrationId}:${watch.folderId}`}
							watch={watch}
							human={watch.account ? nameForAccount(watch.account) : null}
							stopping={stop.isPending && stop.variables === watch.folderId}
							onStop={() => stop.mutate(watch.folderId)}
						/>
					))}
				</ul>
			)}
		</section>
	)
}

function WatchRow({
	watch,
	human,
	stopping,
	onStop,
}: {
	watch: DriveWatch
	human: string | null
	stopping: boolean
	onStop: () => void
}) {
	const fullPath = folderDisplayPath(watch)
	const triggerNames = watch.triggers.map((t) => t.name).join(', ')

	const meta: { key: string; node: ReactNode }[] = []
	if (human) meta.push({ key: 'human', node: human })
	if (triggerNames) meta.push({ key: 'triggers', node: `triggers ${triggerNames}` })
	if (watch.lastFiredAt) {
		meta.push({
			key: 'fired',
			node: (
				<>
					last fired <RelativeTime date={watch.lastFiredAt} />
				</>
			),
		})
	}

	return (
		<li
			className="rounded-md border border-border bg-bg-surface p-3"
			data-testid={`folder-watch-${watch.folderId}`}
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 items-start gap-3">
					<Folder aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
					<div className="min-w-0">
						{/* Shortened at a folder boundary; the full path is the tooltip and the
						    screen-reader text. */}
						<p className="break-words text-sm font-medium text-foreground" title={fullPath}>
							<span aria-hidden="true">{truncatePathAtSeparator(fullPath)}</span>
							<span className="sr-only">{fullPath}</span>
						</p>
						{meta.length > 0 && (
							<p className="text-xs text-muted-foreground" data-testid="folder-watch-meta">
								{meta.map((part, i) => (
									<Fragment key={part.key}>
										{i > 0 && ' · '}
										{part.node}
									</Fragment>
								))}
							</p>
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<McpTag tool="watch_folder" />
					<Button
						size="sm"
						variant="outline"
						onClick={onStop}
						disabled={stopping}
						aria-label={DRIVE_COPY.stopWatchLabel(fullPath)}
					>
						{DRIVE_COPY.stopWatch}
					</Button>
				</div>
			</div>
		</li>
	)
}
