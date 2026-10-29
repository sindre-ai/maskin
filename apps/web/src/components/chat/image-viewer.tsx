import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog'
import { useFile } from '@/hooks/use-files'
import { api } from '@/lib/api'
import type { FileDetail } from '@/lib/api'
import { cn } from '@/lib/cn'
import { downloadFile } from '@/lib/file-utils'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react'
import { toast } from 'sonner'

export interface ViewerImage {
	id: string
	name: string
}

/** The bytes of an image file as something an <img> can show: a data URI, or the storage URL for a large file. */
export function imageSrc(detail: FileDetail): string {
	if (detail.contentOmitted) return detail.downloadUrl ?? ''
	const b64 = detail.encoding === 'base64' ? detail.content : btoa(detail.content)
	return `data:${detail.mimeType};base64,${b64}`
}

/** Saves a file under its own name. Fetches the bytes first, since a chat tile only holds the preview. */
export function downloadFileById(workspaceId: string, fileId: string): void {
	api.files.get(workspaceId, fileId).then(downloadFile, () => toast.error('Download failed'))
}

const ICON_BUTTON_CLASS =
	'inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-9'
const NAV_BUTTON_CLASS =
	'absolute z-10 inline-flex size-11 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-10'

/**
 * Full-screen viewer for the images of one message. Opens on `index`, walks the rest with the
 * arrow buttons or keys, and hands focus back to the tile that opened it when it closes.
 */
export function ImageViewer({
	workspaceId,
	images,
	index,
	onIndexChange,
	onClose,
}: {
	workspaceId: string
	images: ViewerImage[]
	/** The image shown; null keeps the viewer closed. */
	index: number | null
	onIndexChange: (index: number) => void
	onClose: () => void
}) {
	const open = index !== null && images.length > 0
	const current = open ? images[Math.min(index, images.length - 1)] : undefined
	const { data: detail, isError } = useFile(workspaceId, current?.id ?? null)
	const many = images.length > 1
	const at = index ?? 0

	const step = (delta: number) => onIndexChange((at + delta + images.length) % images.length)

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogPortal>
				<DialogOverlay className="bg-background/95" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					onKeyDown={(e) => {
						if (!many) return
						if (e.key === 'ArrowLeft') {
							e.preventDefault()
							step(-1)
						}
						if (e.key === 'ArrowRight') {
							e.preventDefault()
							step(1)
						}
					}}
					className="fixed inset-0 z-50 flex flex-col focus:outline-none"
				>
					<div className="flex items-center gap-2 px-4 py-3">
						<DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
							{current?.name}
						</DialogPrimitive.Title>
						{many ? (
							<span className="text-[11.5px] text-muted-foreground">
								{at + 1} of {images.length}
							</span>
						) : null}
						<button
							type="button"
							aria-label="Download"
							disabled={!detail}
							onClick={() => detail && downloadFile(detail)}
							className={cn(ICON_BUTTON_CLASS, 'disabled:opacity-50')}
						>
							<Download size={16} aria-hidden />
						</button>
						<DialogPrimitive.Close aria-label="Close viewer" className={ICON_BUTTON_CLASS}>
							<X size={16} aria-hidden />
						</DialogPrimitive.Close>
					</div>
					<div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
						{many ? (
							<button
								type="button"
								aria-label="Previous image"
								onClick={() => step(-1)}
								className={cn(NAV_BUTTON_CLASS, 'left-3')}
							>
								<ChevronLeft size={16} aria-hidden />
							</button>
						) : null}
						{detail ? (
							<img
								src={imageSrc(detail)}
								alt={current?.name ?? ''}
								className="max-h-full max-w-full rounded-xl object-contain ring-1 ring-foreground/10"
							/>
						) : isError ? (
							<div className="flex flex-col items-center gap-1 text-muted-foreground">
								<ImageOff size={20} aria-hidden />
								<span className="text-[11.5px]">Can't load this image</span>
							</div>
						) : (
							<div className="aspect-[4/3] w-80 max-w-full animate-pulse rounded-xl bg-muted" />
						)}
						{many ? (
							<button
								type="button"
								aria-label="Next image"
								onClick={() => step(1)}
								className={cn(NAV_BUTTON_CLASS, 'right-3')}
							>
								<ChevronRight size={16} aria-hidden />
							</button>
						) : null}
					</div>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	)
}
