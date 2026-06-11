import { isInlineImage } from '@/components/files/file-body'
import { useFile } from '@/hooks/use-files'
import type { FileListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import { File as FileIcon } from 'lucide-react'

interface AttachedFileCardProps {
	workspaceId: string
	file: Pick<FileListItem, 'name' | 'sizeBytes'> & {
		id?: string
		mimeType?: string
	}
	className?: string
}

const IMAGE_PREVIEW_CLASS =
	'block w-full max-h-64 object-contain rounded-md border border-border bg-card'

/**
 * Small card showing an attached file. Used in both object detail pages (where
 * files attach via relationships) and in posted comments (where file ids live
 * on event.data.attachmentFileIds).
 *
 * For safe inline-image MIME types we fetch the FileDetail and render an
 * <img> whose src is a base64 data URI — `file.url` points to the SPA viewer
 * page, and `<img>` requests don't carry our Bearer header, so the data URI
 * is the only way to render real bytes inline. SVG and other unsafe types
 * fall through to the filename + icon layout.
 *
 * When `file.id` is set, the card is wrapped in a Link that opens the file
 * viewer in a new tab. When `file.id` is absent (an in-progress upload that
 * doesn't yet have a server id), the card renders as a non-link placeholder.
 */
export function AttachedFileCard({ workspaceId, file, className }: AttachedFileCardProps) {
	const canRenderImage = Boolean(file.id && file.mimeType && isInlineImage(file.mimeType))
	const { data: imageDetail } = useFile(workspaceId, canRenderImage ? (file.id ?? null) : null)

	const baseClass = cn(
		'flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors',
		className,
	)

	if (canRenderImage && imageDetail) {
		const b64 = imageDetail.encoding === 'base64' ? imageDetail.content : btoa(imageDetail.content)
		const src = `data:${imageDetail.mimeType};base64,${b64}`
		const img = <img src={src} alt={file.name} className={cn(IMAGE_PREVIEW_CLASS, className)} />

		if (file.id) {
			return (
				<Link
					to="/$workspaceId/files/$fileId"
					params={{ workspaceId, fileId: file.id }}
					target="_blank"
					rel="noopener noreferrer"
					className="block"
				>
					{img}
				</Link>
			)
		}
		return img
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
