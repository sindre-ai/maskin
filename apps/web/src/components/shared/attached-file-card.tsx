import { isInlineImage } from '@/components/files/file-body'
import { useFile } from '@/hooks/use-files'
import type { FileListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import { File as FileIcon } from 'lucide-react'

interface AttachedFileCardProps {
	workspaceId: string
	file: Pick<FileListItem, 'name' | 'sizeBytes'> & { id?: string; mimeType?: string }
	className?: string
}

/**
 * Small clickable card showing an attached file. Used in both object detail
 * pages (where files attach via relationships) and in posted comments (where
 * file ids live on event.data.attachmentFileIds).
 *
 * For inline-safe image MIME types, the card renders the image inline (capped
 * preview) by lazy-loading the file detail and using a base64 data URI —
 * browsers don't send our Bearer token on <img src>, so the same trick
 * FileBody uses applies here. Click-to-open behavior is preserved for both
 * image and non-image cards.
 */
export function AttachedFileCard({ workspaceId, file, className }: AttachedFileCardProps) {
	const isImage = !!file.id && !!file.mimeType && isInlineImage(file.mimeType)
	const { data: detail } = useFile(workspaceId, isImage ? (file.id ?? null) : null)

	const baseClass = cn(
		'flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors',
		className,
	)

	if (isImage && detail) {
		const b64 = detail.encoding === 'base64' ? detail.content : btoa(detail.content)
		const src = `data:${detail.mimeType};base64,${b64}`
		const imageCardClass = cn(
			'block rounded-md border border-border bg-card p-2 transition-colors hover:bg-bg-hover',
			className,
		)
		return (
			<Link
				to="/$workspaceId/files/$fileId"
				params={{ workspaceId, fileId: detail.id }}
				target="_blank"
				rel="noopener noreferrer"
				className={imageCardClass}
				aria-label={file.name}
			>
				<img
					src={src}
					alt={file.name}
					className="max-h-64 max-w-full h-auto w-auto rounded object-contain"
				/>
			</Link>
		)
	}

	const inner = (
		<>
			<FileIcon size={14} className="text-muted-foreground shrink-0" />
			<span className="flex-1 truncate">{file.name}</span>
			<span className="text-xs text-muted-foreground font-mono">{formatSize(file.sizeBytes)}</span>
		</>
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
