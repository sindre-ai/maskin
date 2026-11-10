import { FileTagFilter } from '@/components/files/file-tag-filter'
import { MimeTile, formatBytes } from '@/components/objects/file-tile'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useAllFiles } from '@/hooks/use-files'
import type { FileListItem, FileTagMatch } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

/** The Items page's Files tab: every file in the workspace, each row linking to its viewer. */
export function FilesList({ workspaceId, q }: { workspaceId: string; q?: string }) {
	const [tags, setTags] = useState<string[]>([])
	const [match, setMatch] = useState<FileTagMatch>('all')
	const {
		data: files,
		isLoading,
		isError,
		error,
		refetch,
	} = useAllFiles(workspaceId, q, { tags, match })
	const { data: actors } = useActors(workspaceId)
	const actorNames = useMemo(() => new Map((actors ?? []).map((a) => [a.id, a.name])), [actors])

	return (
		<>
			<FileTagFilter
				workspaceId={workspaceId}
				tags={tags}
				match={match}
				onTagsChange={setTags}
				onMatchChange={setMatch}
			/>
			<FilesRows
				workspaceId={workspaceId}
				q={q}
				filtered={tags.length > 0}
				files={files}
				actorNames={actorNames}
				isLoading={isLoading}
				isError={isError}
				error={error}
				refetch={refetch}
			/>
		</>
	)
}

function FilesRows({
	workspaceId,
	q,
	filtered,
	files,
	actorNames,
	isLoading,
	isError,
	error,
	refetch,
}: {
	workspaceId: string
	q?: string
	filtered: boolean
	files: FileListItem[] | undefined
	actorNames: Map<string, string>
	isLoading: boolean
	isError: boolean
	error: Error | null
	refetch: () => void
}) {
	if (isLoading) return <ListSkeleton rows={8} />
	if (isError) {
		return (
			<EmptyState
				title="Failed to load files"
				description={error instanceof Error ? error.message : undefined}
				action={
					<Button variant="outline" size="sm" onClick={() => refetch()}>
						Retry
					</Button>
				}
			/>
		)
	}
	if (!files || files.length === 0) {
		return (
			<EmptyState
				title={
					q ? `No files match “${q}”.` : filtered ? 'No files have these tags' : 'No files yet'
				}
			/>
		)
	}

	return (
		<ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
			{files.map((file) => {
				const author = actorNames.get(file.createdBy)
				return (
					<li key={file.id}>
						<Link
							to="/$workspaceId/files/$fileId"
							params={{ workspaceId, fileId: file.id }}
							className="flex min-w-0 items-center gap-3 px-1 py-2.5 hover:bg-muted/50"
						>
							<MimeTile mimeType={file.mimeType} />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-sm font-medium text-foreground">{file.name}</span>
								<span className="truncate text-xs text-muted-foreground">
									{[formatBytes(file.sizeBytes), author].filter(Boolean).join(' · ')}
								</span>
							</span>
							<RelativeTime
								date={file.updatedAt}
								compact
								className="shrink-0 text-xs text-muted-foreground"
							/>
						</Link>
					</li>
				)
			})}
		</ul>
	)
}
