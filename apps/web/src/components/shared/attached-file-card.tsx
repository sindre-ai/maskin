import type { FileListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import { File as FileIcon } from 'lucide-react'

interface AttachedFileCardProps {
	workspaceId: string
	file: Pick<FileListItem, 'name' | 'sizeBytes'> & { id?: string }
	className?: string
}

/**
 * Small clickable card showing an attached file. Used in both object detail
 * pages (where files attach via relationships) and in posted comments (where
 * file ids live on event.data.attachmentFileIds).
 *
 * When `file.id` is set, clicking opens the file preview in a new tab. When
 * `file.id` is absent (an in-progress upload that doesn't yet have a server
 * id), the card renders as a non-link placeholder.
 */
export function AttachedFileCard({ workspaceId, file, className }: AttachedFileCardProps) {
	const inner = (
		<>
			<FileIcon size={14} className="text-muted-foreground shrink-0" />
			<span className="flex-1 truncate">{file.name}</span>
			<span className="text-xs text-muted-foreground font-mono">{formatSize(file.sizeBytes)}</span>
		</>
	)

	const baseClass = cn(
		'flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors',
		className,
	)

	if (file.id) {
		return (
			<Link
				to="/$workspaceId/files/$fileId"
				params={{ workspaceId, fileId: file.id }}
				target="_blank"
				rel="noopener noreferrer"
				className={cn(baseClass, 'hover:bg-bg-hover')}
			>
				{inner}
			</Link>
		)
	}

	return <div className={baseClass}>{inner}</div>
}
