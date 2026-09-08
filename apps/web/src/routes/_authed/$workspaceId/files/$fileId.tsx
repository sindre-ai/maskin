import { PinFileButton } from '@/components/files/pin-file-button'
import { ViewerStage } from '@/components/files/viewer-stage'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useFile } from '@/hooks/use-files'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { ApiError, type FileDetail } from '@/lib/api'
import { base64ToBytes } from '@/lib/file-utils'
import { isPinned, togglePinnedFile } from '@/lib/pinned-files'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Download, MessageSquare, MoreHorizontal } from 'lucide-react'
import { useCallback, useMemo } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/files/$fileId')({
	component: FileViewerPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function downloadFile(file: FileDetail): void {
	const blob =
		file.encoding === 'utf8'
			? new Blob([file.content], { type: file.mimeType })
			: new Blob([base64ToBytes(file.content).buffer as ArrayBuffer], { type: file.mimeType })
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = file.name
	document.body.appendChild(a)
	a.click()
	document.body.removeChild(a)
	URL.revokeObjectURL(url)
}

function FileViewerPage() {
	const { fileId } = Route.useParams()
	const { workspace, workspaceId } = useWorkspace()
	const { data: file, isLoading, error } = useFile(workspaceId, fileId)
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const pinned = useMemo(() => isPinned(workspace, fileId), [workspace, fileId])

	const handleTogglePin = useCallback(
		(id: string) => {
			updateWorkspace.mutate({ settings: { pinned_files: togglePinnedFile(workspace, id) } })
		},
		[updateWorkspace, workspace],
	)

	if (isLoading) {
		return (
			<>
				<PageHeader
					scrollLocked
					crumb={{
						parentLabel: 'Files',
						parentTo: '/$workspaceId/files',
						parentParams: { workspaceId },
						label: 'Loading…',
					}}
				/>
				<ViewerShell>
					<div
						className="flex h-full w-full items-center justify-center bg-muted"
						data-viewer-state="loading"
					>
						<Spinner />
					</div>
				</ViewerShell>
			</>
		)
	}

	if (error || !file) {
		const is404 = error instanceof ApiError && error.status === 404
		return (
			<>
				<PageHeader
					scrollLocked
					crumb={{
						parentLabel: 'Files',
						parentTo: '/$workspaceId/files',
						parentParams: { workspaceId },
						label: is404 ? 'Not found' : 'Failed to load',
					}}
				/>
				<ViewerShell>
					<div
						className="flex h-full w-full items-center justify-center bg-muted p-8"
						data-viewer-state={is404 ? 'file-404' : 'load-error'}
					>
						<EmptyState
							title={is404 ? 'File not found' : 'Failed to load file'}
							description={
								is404
									? 'This file may have been deleted, or you might not have access to it.'
									: error?.message
							}
						/>
					</div>
				</ViewerShell>
			</>
		)
	}

	return (
		<>
			<PageHeader
				scrollLocked
				crumb={{
					parentLabel: 'Files',
					parentTo: '/$workspaceId/files',
					parentParams: { workspaceId },
					label: file.name,
				}}
				actions={<TopBarActions file={file} isPinned={pinned} onTogglePin={handleTogglePin} />}
			/>
			<ViewerShell>
				<ViewerStage file={file} />
			</ViewerShell>
		</>
	)
}

// The route's outer container: strips the legacy `max-w-3xl mx-auto` column and
// gives the stage the full width of the shell. The layout's `[data-scroll-root]`
// is already `overflow-hidden` because PageHeader publishes `scrollLocked`, so
// this region is the viewer's only live scroll parent.
function ViewerShell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
	)
}

// Right-side cluster on the shared detail bar: pin, download, then the Review
// toggle and ⋯ menu placeholders. Contents of the ⋯ menu (Pin-to-sidebar /
// Copy link / View source / Delete) and the Review panel itself land in
// Slice 3 — Slice 1 owns the slots so the layout math is real, not deferred.
function TopBarActions({
	file,
	isPinned: pinnedFlag,
	onTogglePin,
}: {
	file: FileDetail
	isPinned: boolean
	onTogglePin: (id: string) => void
}) {
	return (
		<div className="flex items-center gap-1">
			<PinFileButton file={file} isPinned={pinnedFlag} onToggle={onTogglePin} />
			<Button
				variant="ghost"
				size="sm"
				onClick={() => downloadFile(file)}
				aria-label="Download file"
			>
				<Download size={14} />
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled
				aria-label="Review panel — wired in Slice 3"
				title="Review — coming in Slice 3"
			>
				<MessageSquare size={14} />
				Review
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled
				aria-label="More actions — wired in Slice 3"
				title="More — coming in Slice 3"
			>
				<MoreHorizontal size={14} />
			</Button>
		</div>
	)
}
