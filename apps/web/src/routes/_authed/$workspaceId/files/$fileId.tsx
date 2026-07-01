import { FileBody } from '@/components/files/file-body'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useFile } from '@/hooks/use-files'
import type { AnnotationJson } from '@/lib/annotations'
import { buildRevisePrompt } from '@/lib/annotations'
import { ApiError, type FileDetail, api } from '@/lib/api'
import { base64ToBytes } from '@/lib/file-utils'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

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

export const Route = createFileRoute('/_authed/$workspaceId/files/$fileId')({
	component: FileViewerPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileViewerPage() {
	const { fileId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: file, isLoading, error } = useFile(workspaceId, fileId)
	const { data: actors } = useActors(workspaceId)
	const [isRevising, setIsRevising] = useState(false)

	const designAgent = actors?.find(
		(a) => a.type === 'agent' && a.name.toLowerCase().includes('design'),
	)

	const handleReviseWithAnnotations = useCallback(
		async (annotationJson: AnnotationJson) => {
			if (!file || !designAgent) return
			setIsRevising(true)
			try {
				await api.sessions.create(workspaceId, {
					actor_id: designAgent.id,
					action_prompt: buildRevisePrompt(file, annotationJson),
					auto_start: true,
				})
				toast.success('Design Agent session started')
			} catch {
				toast.error('Failed to start Design Agent session')
			} finally {
				setIsRevising(false)
			}
		},
		[file, designAgent, workspaceId],
	)

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-[var(--space-4)]">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (error || !file) {
		const is404 = error instanceof ApiError && error.status === 404
		return (
			<>
				<PageHeader />
				<EmptyState
					title={is404 ? 'File not found' : 'Failed to load file'}
					description={
						is404
							? 'This file may have been deleted, or you might not have access to it.'
							: error?.message
					}
				/>
			</>
		)
	}

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto space-y-[var(--space-6)]">
				<header className="space-y-[var(--space-2)]">
					<h1 className="text-2xl font-semibold text-text break-words">{file.name}</h1>
					{file.description && <p className="text-sm text-text-secondary">{file.description}</p>}
					<div className="flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-1)] text-xs text-text-muted">
						<span className="font-mono break-all">{file.mimeType}</span>
						<span aria-hidden="true">·</span>
						<span>{formatSize(file.sizeBytes)}</span>
						<span aria-hidden="true">·</span>
						<RelativeTime date={file.createdAt} />
					</div>
				</header>

				<div className="flex justify-end">
					<Button variant="outline" size="sm" onClick={() => downloadFile(file)}>
						<Download size={14} />
						Download
					</Button>
				</div>

				<FileBody
					file={file}
					onReviseWithAnnotations={designAgent ? handleReviseWithAnnotations : undefined}
					isRevising={isRevising}
				/>
			</div>
		</>
	)
}
