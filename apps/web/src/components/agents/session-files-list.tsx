import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSessionFiles } from '@/hooks/use-sessions'
import { api } from '@/lib/api'
import type { SessionFileResponse } from '@/lib/api'
import { downloadBlob } from '@/lib/download'
import { Download } from 'lucide-react'
import { useState } from 'react'

interface SessionFilesListProps {
	sessionId: string
	workspaceId: string
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—'
	if (bytes === 0) return '0 B'
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
		value /= 1024
		unit++
	}
	const formatted =
		value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')
	return `${formatted} ${SIZE_UNITS[unit]}`
}

function basename(path: string): string {
	return path.split('/').pop() || path
}

export function SessionFilesList({ sessionId, workspaceId }: SessionFilesListProps) {
	const { data, isLoading, isError } = useSessionFiles(sessionId, workspaceId)
	const [downloading, setDownloading] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const handleDownload = async (file: SessionFileResponse) => {
		setDownloading(file.path)
		setError(null)
		try {
			const blob = await api.sessions.downloadFile(sessionId, file.path, workspaceId)
			downloadBlob(blob, basename(file.path))
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Download failed')
		} finally {
			setDownloading(null)
		}
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-6">
				<Spinner />
			</div>
		)
	}

	if (isError) {
		return <p className="text-sm text-muted-foreground py-2 text-center">Couldn't load files</p>
	}

	const files = data?.files ?? []
	if (files.length === 0) {
		return (
			<EmptyState
				title="No files"
				description="This session didn't produce any downloadable files."
			/>
		)
	}

	return (
		<div className="space-y-1">
			{files.map((file) => (
				<div
					key={file.path}
					className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
				>
					<div className="min-w-0 flex-1">
						<p className="text-sm truncate" title={file.path}>
							{file.path}
						</p>
						<p className="text-[11px] text-muted-foreground">{formatBytes(file.size_bytes)}</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => handleDownload(file)}
						disabled={downloading === file.path}
						aria-label={`Download ${file.path}`}
					>
						<Download size={14} />
						{downloading === file.path ? 'Downloading…' : 'Download'}
					</Button>
				</div>
			))}
			{error && <p className="text-xs text-error pt-1">{error}</p>}
		</div>
	)
}
