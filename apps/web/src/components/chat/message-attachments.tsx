import {
	ImageViewer,
	type ViewerImage,
	downloadFileById,
	imageSrc,
} from '@/components/chat/image-viewer'
import { isInlineImage } from '@/components/files/file-body'
import { useFile } from '@/hooks/use-files'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/file-utils'
import { Link } from '@tanstack/react-router'
import {
	AlertTriangle,
	Download,
	Image as ImageIcon,
	ImageOff,
	Maximize2,
	RotateCcw,
	X,
} from 'lucide-react'
import { useRef, useState } from 'react'

/** One file on a message, as the chat draws it. `status` is only set while a send is in flight or has failed. */
export interface MessageAttachmentItem {
	id?: string
	name: string
	sizeBytes: number
	mimeType?: string
	status?: 'uploading' | 'failed' | 'gone'
	/** 0 to 100, shown while `status` is uploading. */
	progress?: number
	onRetry?: () => void
	onCancel?: () => void
}

const TILE_CLASS = 'group relative block size-full min-h-0 min-w-0 overflow-hidden rounded-md'
const HAIRLINE_CLASS =
	'pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/10 group-focus-within:ring-2 group-focus-within:ring-ring'
const SMALL_BUTTON_CLASS =
	'inline-flex h-11 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[12.5px] font-semibold text-foreground transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8'

/**
 * The images and files of one message, lifted out of the text bubble. Order is always images,
 * files; the caller draws the text bubble after this block. `align` follows the message side.
 */
export function MessageAttachments({
	workspaceId,
	items,
	align,
	fill = false,
}: {
	workspaceId: string
	items: MessageAttachmentItem[]
	align: 'start' | 'end'
	/** Images and files take the width of the box they sit in, instead of their own fixed sizes. */
	fill?: boolean
}) {
	const images = items.filter(isImageItem)
	const files = items.filter((item) => !isImageItem(item))
	if (images.length === 0 && files.length === 0) return null
	return (
		<div
			className={cn('flex w-full flex-col gap-1', align === 'end' ? 'items-end' : 'items-start')}
		>
			{images.length > 0 ? (
				<ImageBlock workspaceId={workspaceId} images={images} fill={fill} />
			) : null}
			{files.length > 0 ? (
				<ul className="m-0 flex w-full list-none flex-col gap-1 p-0" aria-label="Attached files">
					{files.map((file) => (
						<li
							key={file.id ?? file.name}
							className={cn('flex w-full', align === 'end' ? 'justify-end' : 'justify-start')}
						>
							<FileCard workspaceId={workspaceId} file={file} fill={fill} />
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}

function isImageItem(item: MessageAttachmentItem): boolean {
	return !!item.mimeType && isInlineImage(item.mimeType) && item.status !== 'gone'
}

// ---------- images ----------

type SingleShape = 'landscape' | 'portrait' | 'square'

// One image keeps its shape between 4:3 and 3:4; a square one gets its own, slightly narrower block.
const SINGLE_SHAPE_CLASS: Record<SingleShape, string> = {
	landscape: 'aspect-[4/3] w-80 max-w-[80%]',
	portrait: 'aspect-[3/4] w-60 max-w-[70%]',
	square: 'aspect-square w-[260px] max-w-[75%]',
}

const SINGLE_SHAPE_RATIO: Record<SingleShape, string> = {
	landscape: 'aspect-[4/3] w-full',
	portrait: 'aspect-[3/4] w-full',
	square: 'aspect-square w-full',
}

function shapeOf(ratio: number): SingleShape {
	if (ratio >= 1.15) return 'landscape'
	if (ratio <= 0.87) return 'portrait'
	return 'square'
}

function ImageBlock({
	workspaceId,
	images,
	fill,
}: {
	workspaceId: string
	images: MessageAttachmentItem[]
	fill: boolean
}) {
	const [shape, setShape] = useState<SingleShape>('landscape')
	const [viewerIndex, setViewerIndex] = useState<number | null>(null)
	// The tile that opened the viewer, so focus can go back to it on close.
	const openerRef = useRef<HTMLElement | null>(null)

	// Only a saved image can be opened; a tile still uploading or failed sits out of the viewer.
	const viewable: ViewerImage[] = []
	const viewerPosition = new Map<number, number>()
	images.forEach((image, i) => {
		if (image.id && !image.status) {
			viewerPosition.set(i, viewable.length)
			viewable.push({ id: image.id, name: image.name })
		}
	})

	const shown = images.slice(0, 4)
	const more = images.length - 4
	const tile = (i: number, className?: string) => (
		<li key={images[i].id ?? images[i].name} className={cn('min-h-0 min-w-0', className)}>
			<ImageTile
				workspaceId={workspaceId}
				item={images[i]}
				position={i + 1}
				moreCount={i === 3 && more > 0 ? more : 0}
				onOpen={(opener) => {
					const at = viewerPosition.get(i)
					if (at === undefined) return
					openerRef.current = opener
					setViewerIndex(at)
				}}
				onRatio={images.length === 1 ? (ratio) => setShape(shapeOf(ratio)) : undefined}
			/>
		</li>
	)

	// Filled, the block is as wide as its box and keeps each layout's shape.
	const width = fill ? 'w-full' : 'w-80 max-w-[80%]'
	let layout: string
	if (images.length === 1)
		layout = cn('grid-cols-1', fill ? SINGLE_SHAPE_RATIO[shape] : SINGLE_SHAPE_CLASS[shape])
	else if (images.length === 2) layout = `aspect-[2/1] ${width} grid-cols-2`
	else if (images.length === 3) layout = `aspect-[4/3] ${width} grid-cols-2 grid-rows-2`
	else layout = `aspect-square ${width} grid-cols-2 grid-rows-2`

	return (
		<>
			<ul
				className={cn('m-0 grid list-none gap-1 overflow-hidden rounded-xl p-0', layout)}
				aria-label={images.length === 1 ? 'Attached image' : `${images.length} attached images`}
			>
				{images.length === 3
					? [tile(0, 'row-span-2'), tile(1), tile(2)]
					: shown.map((_, i) => tile(i))}
			</ul>
			<ImageViewer
				workspaceId={workspaceId}
				images={viewable}
				index={viewerIndex}
				returnFocusRef={openerRef}
				onIndexChange={setViewerIndex}
				onClose={() => setViewerIndex(null)}
			/>
		</>
	)
}

function ImageTile({
	workspaceId,
	item,
	position,
	moreCount,
	onOpen,
	onRatio,
}: {
	workspaceId: string
	item: MessageAttachmentItem
	position: number
	/** On the fourth tile of a longer set: how many more images the viewer holds. */
	moreCount: number
	onOpen: (opener: HTMLElement) => void
	/** Reports the picture's own shape so a single image can take it. */
	onRatio?: (ratio: number) => void
}) {
	const inFlight = item.status === 'uploading' || item.status === 'failed'
	const { data, isError } = useFile(workspaceId, inFlight || !item.id ? null : item.id)

	if (item.status === 'uploading') {
		const percent = Math.round(item.progress ?? 0)
		return (
			<div
				role="img"
				aria-label={`Uploading ${item.name}, ${percent} percent`}
				className={cn(TILE_CLASS, 'bg-muted')}
			>
				<span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/70">
					<ProgressRing percent={percent} />
					<span className="text-[11.5px] font-semibold text-foreground">{percent}%</span>
				</span>
				<span aria-hidden className={HAIRLINE_CLASS} />
			</div>
		)
	}

	if (item.status === 'failed') {
		return (
			<div className={cn(TILE_CLASS, 'bg-muted')}>
				<span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background/85 px-3 text-center">
					<AlertTriangle size={20} aria-hidden className="text-error" />
					<span className="text-[12.5px] font-semibold text-foreground">Couldn't upload</span>
					<button type="button" onClick={item.onRetry} className={SMALL_BUTTON_CLASS}>
						<RotateCcw size={14} aria-hidden />
						Retry
					</button>
				</span>
				<span
					aria-hidden
					className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-inset ring-error"
				/>
			</div>
		)
	}

	if (!item.id || isError) {
		return (
			<div className={cn(TILE_CLASS, 'bg-secondary')}>
				<span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center text-muted-foreground">
					<ImageOff size={20} aria-hidden />
					<span className="max-w-full truncate text-[11.5px] font-semibold text-foreground">
						{item.name}
					</span>
					<span className="text-[11.5px]">Can't load this image</span>
				</span>
				<span aria-hidden className={HAIRLINE_CLASS} />
			</div>
		)
	}

	if (!data) {
		return (
			<div
				role="img"
				aria-label="Loading image"
				className={cn(TILE_CLASS, 'animate-pulse bg-muted')}
			>
				<span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
					<ImageIcon size={20} aria-hidden />
				</span>
				<span aria-hidden className={HAIRLINE_CLASS} />
			</div>
		)
	}

	const id = item.id
	return (
		<div className={TILE_CLASS}>
			<img
				src={imageSrc(data)}
				alt=""
				onLoad={(e) => {
					const { naturalWidth, naturalHeight } = e.currentTarget
					if (onRatio && naturalWidth > 0 && naturalHeight > 0)
						onRatio(naturalWidth / naturalHeight)
				}}
				className="size-full object-cover transition-opacity duration-180"
			/>
			<button
				type="button"
				onClick={(e) => onOpen(e.currentTarget)}
				aria-label={`Image ${position}, ${item.name}, open`}
				className="absolute inset-0 focus-visible:outline-none"
			/>
			{moreCount > 0 ? (
				<span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-xl font-bold text-foreground">
					+{moreCount}
				</span>
			) : (
				<span className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-180 focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:hidden">
					<button
						type="button"
						aria-label={`Download ${item.name}`}
						onClick={() => downloadFileById(workspaceId, id)}
						className="inline-flex size-7 items-center justify-center rounded-md bg-background/85 text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Download size={14} aria-hidden />
					</button>
					<span className="pointer-events-none inline-flex size-7 items-center justify-center rounded-md bg-background/85 text-foreground shadow-xs">
						<Maximize2 size={14} aria-hidden />
					</span>
				</span>
			)}
			<span aria-hidden className={HAIRLINE_CLASS} />
		</div>
	)
}

const RING_LENGTH = 94.2

function ProgressRing({ percent }: { percent: number }) {
	return (
		<svg viewBox="0 0 36 36" className="size-9 -rotate-90" aria-hidden="true">
			<circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-foreground/15" />
			<circle
				cx="18"
				cy="18"
				r="15"
				fill="none"
				strokeWidth="3"
				strokeLinecap="round"
				strokeDasharray={RING_LENGTH}
				strokeDashoffset={RING_LENGTH * (1 - Math.min(100, Math.max(0, percent)) / 100)}
				className="stroke-brand"
			/>
		</svg>
	)
}

// ---------- files ----------

interface FileKind {
	/** Short tag in the lead tile, in the extension's own spelling. */
	tag: string
	/** What the file is, in words, beside its size. */
	label: string
	tone: string
}

const KIND_PDF = { tag: 'PDF', label: 'PDF', tone: 'bg-status-failed-bg text-status-failed-text' }
const KIND_FILE_TONE = 'bg-type-file-bg text-type-file-text'

export function fileKindOf(name: string, mimeType?: string): FileKind {
	const dot = name.lastIndexOf('.')
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
	const tag = ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
	if (mimeType === 'application/pdf' || ext === 'pdf') return KIND_PDF
	if (mimeType === 'text/markdown' || ext === 'md')
		return { tag: 'MD', label: 'Markdown', tone: KIND_FILE_TONE }
	if (['xlsx', 'xls', 'csv', 'tsv', 'numbers'].includes(ext))
		return { tag, label: 'Spreadsheet', tone: 'bg-status-live-bg text-status-live-text' }
	if (['zip', 'gz', 'tar', 'tgz', '7z', 'rar'].includes(ext))
		return { tag, label: 'Archive', tone: 'bg-status-paused-bg text-status-paused-text' }
	if (['doc', 'docx', 'pages', 'rtf'].includes(ext))
		return { tag, label: 'Document', tone: KIND_FILE_TONE }
	if (mimeType?.startsWith('text/') || ['txt', 'json', 'yaml', 'yml', 'xml'].includes(ext))
		return { tag, label: 'Text', tone: KIND_FILE_TONE }
	return { tag, label: 'File', tone: 'bg-secondary text-muted-foreground' }
}

const CARD_CLASS =
	'group relative flex items-center gap-3 rounded-lg border bg-card p-2.5 pr-3 text-card-foreground transition-colors'

// A PDF would show its first page here, but the API serves no page preview; every file gets the
// type tile until it does.
function FileLead({ kind }: { kind: FileKind }) {
	return (
		<span
			className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', kind.tone)}
			aria-hidden
		>
			<span className="font-mono text-[10px] font-bold">{kind.tag}</span>
		</span>
	)
}

function FileCard({
	workspaceId,
	file,
	fill,
}: {
	workspaceId: string
	file: MessageAttachmentItem
	fill: boolean
}) {
	const cardClass = cn(CARD_CLASS, fill ? 'w-full' : 'w-80 max-w-[92%]')
	const kind = fileKindOf(file.name, file.mimeType)
	const lead = <FileLead kind={kind} />

	if (file.status === 'uploading') {
		const percent = Math.round(file.progress ?? 0)
		return (
			<div className={cn(cardClass, 'border-border')}>
				{lead}
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-semibold text-foreground">
						{file.name}
					</span>
					<span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-secondary">
						<span
							className="block h-full rounded-full bg-brand transition-[width]"
							style={{ width: `${percent}%` }}
						/>
					</span>
					<span className="mt-1 block text-[11.5px] text-muted-foreground">
						Uploading, {percent}%
					</span>
				</span>
				<button
					type="button"
					aria-label={`Cancel upload of ${file.name}`}
					onClick={file.onCancel}
					className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-8"
				>
					<X size={14} aria-hidden />
				</button>
			</div>
		)
	}

	if (file.status === 'failed') {
		return (
			<div className={cn(cardClass, 'border-error')}>
				{lead}
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-semibold text-foreground">
						{file.name}
					</span>
					<span className="flex items-center gap-1 whitespace-nowrap text-[11.5px] font-semibold text-error">
						<AlertTriangle size={12} aria-hidden />
						Couldn't upload
					</span>
				</span>
				<button type="button" onClick={file.onRetry} className={cn(SMALL_BUTTON_CLASS, 'shrink-0')}>
					<RotateCcw size={14} aria-hidden />
					Retry
				</button>
			</div>
		)
	}

	if (file.status === 'gone' || !file.id) {
		return (
			<div className={cn(cardClass, 'border-border-subtle opacity-80')}>
				{lead}
				<span className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-semibold text-muted-foreground line-through">
						{file.name}
					</span>
					<span className="block text-[11.5px] text-muted-foreground">
						File no longer available
					</span>
				</span>
			</div>
		)
	}

	const id = file.id
	return (
		<div className={cn(cardClass, 'border-border hover:border-border-strong hover:bg-secondary')}>
			<Link
				to="/$workspaceId/files/$fileId"
				params={{ workspaceId, fileId: id }}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={`Open ${file.name}`}
				className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			{lead}
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-semibold text-foreground">
					{file.name}
				</span>
				<span className="block truncate text-[11.5px] text-muted-foreground">
					{kind.label} · {formatSize(file.sizeBytes)}
				</span>
			</span>
			<button
				type="button"
				aria-label={`Download ${file.name}`}
				onClick={() => downloadFileById(workspaceId, id)}
				className="relative z-10 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-8"
			>
				<Download size={16} aria-hidden />
			</button>
		</div>
	)
}
