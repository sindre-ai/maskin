import { ImageViewer, imageSrc } from '@/components/chat/image-viewer'
import { MediaPlayer, isInlineImage, isVideo } from '@/components/files/file-body'
import { FilePreview } from '@/components/shared/file-preview'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useFile, useFiles } from '@/hooks/use-files'
import type { FileListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ChevronLeft, ChevronRight, ImageOff } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

// A picture past this size is not worth shipping into a card; it shows as a file header instead.
const MAX_IMAGE_BYTES = 8_000_000

/** How far from the slide in view a slide still loads its bytes: the next and the one before. */
const LOAD_AHEAD = 1

/** The longest a button-driven scroll is trusted to run before the scroll position is read again. */
const SCROLL_SETTLE_MS = 1000

/**
 * The media of a draft's preview, drawn after its text and before Approve, the way the post
 * reads: text, then slides. The one place a card puts it, so every surface orders it the same.
 * Nothing when the draft lists no files.
 */
export function DraftMedia({
	preview,
	workspaceId,
	className,
}: { preview: { media_file_ids?: string[] }; workspaceId: string; className?: string }) {
	const ids = preview.media_file_ids ?? []
	if (ids.length === 0) return null
	return (
		<div className={className}>
			<PreviewMedia workspaceId={workspaceId} fileIds={ids} />
		</div>
	)
}

interface PreviewMediaProps {
	workspaceId: string
	/** The files that go out with the draft, in the order they go (`preview.media_file_ids`). */
	fileIds: string[]
}

/**
 * Everything that goes out with a draft besides its text: the images of a post or a carousel,
 * a video, a document. One strip, in the order the draft lists them: a single item is drawn as
 * it is, several are slides to swipe, step through with the buttons or the arrow keys, or open
 * in the image viewer. A file that is missing or belongs to another workspace is skipped, and
 * a file id is never shown. Part of what a person approves, so it sits above the text.
 */
export function PreviewMedia({ workspaceId, fileIds }: PreviewMediaProps) {
	const { data, isLoading } = useFiles(workspaceId, { ids: fileIds })
	const [index, setIndex] = useState(0)
	const [viewerAt, setViewerAt] = useState<number | null>(null)
	const scroller = useRef<HTMLDivElement>(null)
	const opener = useRef<HTMLElement | null>(null)
	// Where a button or arrow key is scrolling to. Until it gets there, scroll events are the
	// animation passing through slides, not a swipe, so they must not set the index back.
	const scrollTarget = useRef<number | null>(null)
	const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	useEffect(() => () => clearTimeout(settleTimer.current), [])

	if (fileIds.length === 0) return null
	if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" aria-label="Loading media" />

	const byId = new Map((data ?? []).map((file) => [file.id, file]))
	const items = [...new Set(fileIds)].flatMap((id) => {
		const file = byId.get(id)
		return file ? [file] : []
	})
	if (items.length === 0) return null

	const many = items.length > 1
	const current = Math.min(index, items.length - 1)
	const images = items.filter(isSlideImage)

	const go = (to: number) => {
		const next = Math.max(0, Math.min(items.length - 1, to))
		setIndex(next)
		const el = scroller.current
		if (el && typeof el.scrollTo === 'function') {
			scrollTarget.current = next * el.clientWidth
			clearTimeout(settleTimer.current)
			settleTimer.current = setTimeout(() => readIndex(el), SCROLL_SETTLE_MS)
			el.scrollTo({ left: scrollTarget.current, behavior: 'smooth' })
		}
	}

	// The slide in view, read back from the scroll position. Ends any button-driven scroll.
	const readIndex = (el: HTMLElement) => {
		scrollTarget.current = null
		clearTimeout(settleTimer.current)
		if (el.clientWidth > 0) setIndex(Math.round(el.scrollLeft / el.clientWidth))
	}

	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (!many) return
		if (e.key === 'ArrowRight') {
			e.preventDefault()
			go(current + 1)
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault()
			go(current - 1)
		}
	}

	return (
		<section
			aria-roledescription={many ? 'carousel' : undefined}
			aria-label={many ? `Media, ${items.length} items` : 'Media'}
			onKeyDown={onKeyDown}
			className="flex flex-col gap-1.5"
		>
			<div
				ref={scroller}
				// Swiping settles on a slide; the slide in view is read back from the scroll position.
				onScroll={(e) => {
					const el = e.currentTarget
					const target = scrollTarget.current
					if (target !== null && Math.abs(el.scrollLeft - target) >= 1) return
					readIndex(el)
				}}
				className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-muted [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{items.map((file, i) => (
					<div
						key={file.id}
						className="flex w-full shrink-0 snap-center items-center justify-center"
					>
						<Slide
							workspaceId={workspaceId}
							file={file}
							load={Math.abs(i - current) <= LOAD_AHEAD}
							onOpen={(el) => {
								opener.current = el
								setViewerAt(images.findIndex((image) => image.id === file.id))
							}}
						/>
					</div>
				))}
			</div>
			{many ? (
				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label="Previous"
						disabled={current === 0}
						onClick={() => go(current - 1)}
					>
						<ChevronLeft size={16} aria-hidden />
					</Button>
					<div className="flex min-w-0 flex-col items-center gap-1">
						<span aria-live="polite" className="font-mono text-xs text-muted-foreground">
							{current + 1} / {items.length}
						</span>
						{items.length <= 12 ? (
							<div className="flex items-center gap-1.5" aria-hidden>
								{items.map((file, i) => (
									<span
										key={file.id}
										className={cn(
											'size-1.5 rounded-full',
											i === current ? 'bg-foreground' : 'bg-border-strong',
										)}
									/>
								))}
							</div>
						) : null}
					</div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label="Next"
						disabled={current === items.length - 1}
						onClick={() => go(current + 1)}
					>
						<ChevronRight size={16} aria-hidden />
					</Button>
				</div>
			) : null}
			<ImageViewer
				workspaceId={workspaceId}
				images={images.map((image) => ({ id: image.id, name: image.name }))}
				index={viewerAt !== null && viewerAt >= 0 ? viewerAt : null}
				returnFocusRef={opener}
				onIndexChange={setViewerAt}
				onClose={() => setViewerAt(null)}
			/>
		</section>
	)
}

function isSlideImage(file: FileListItem): boolean {
	return isInlineImage(file.mimeType) && file.sizeBytes <= MAX_IMAGE_BYTES
}

function Slide({
	workspaceId,
	file,
	load,
	onOpen,
}: {
	workspaceId: string
	file: FileListItem
	/** False for a slide far from the one in view: it holds its place and fetches nothing. */
	load: boolean
	onOpen: (opener: HTMLElement) => void
}) {
	if (isSlideImage(file)) {
		return <ImageSlide workspaceId={workspaceId} file={file} load={load} onOpen={onOpen} />
	}
	if (isVideo(file.mimeType)) {
		return <VideoSlide workspaceId={workspaceId} file={file} load={load} />
	}
	// A document or anything else: its header, with a link to the viewer.
	return (
		<FilePreview
			workspaceId={workspaceId}
			fileId={file.id}
			meta={{ name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes }}
			className="m-3 mt-3 w-full max-w-none bg-background"
		/>
	)
}

const SLIDE_HEIGHT = 'h-72 md:h-96'

function ImageSlide({
	workspaceId,
	file,
	load,
	onOpen,
}: {
	workspaceId: string
	file: FileListItem
	load: boolean
	onOpen: (opener: HTMLElement) => void
}) {
	const { data, isError } = useFile(workspaceId, load ? file.id : null)
	if (isError) {
		return (
			<div
				className={cn(
					SLIDE_HEIGHT,
					'flex w-full flex-col items-center justify-center gap-1 text-muted-foreground',
				)}
			>
				<ImageOff size={20} aria-hidden />
				<span className="text-xs">Can't load this image</span>
			</div>
		)
	}
	if (!data) return <Skeleton className={cn(SLIDE_HEIGHT, 'w-full rounded-none')} />
	return (
		<button
			type="button"
			aria-label={`Open ${file.name}`}
			onClick={(e) => onOpen(e.currentTarget)}
			className="flex w-full items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<img
				src={imageSrc(data)}
				alt={file.name}
				loading="lazy"
				className={cn(SLIDE_HEIGHT, 'w-full object-contain')}
			/>
		</button>
	)
}

function VideoSlide({
	workspaceId,
	file,
	load,
}: {
	workspaceId: string
	file: FileListItem
	load: boolean
}) {
	const { data } = useFile(workspaceId, load ? file.id : null)
	if (!data) return <Skeleton className={cn(SLIDE_HEIGHT, 'w-full rounded-none')} />
	return <MediaPlayer file={data} className={cn(SLIDE_HEIGHT, 'w-full bg-background')} />
}
