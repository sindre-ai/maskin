import { useLinkedPanel } from '@/components/chat/linked-panel-context'
import { isHtml, isInlineImage, isMarkdown, isPlainText } from '@/components/files/file-body'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Spinner } from '@/components/ui/spinner'
import { useFile, useFiles } from '@/hooks/use-files'
import type { FileDetail } from '@/lib/api'
import { cn } from '@/lib/cn'
import { decodeBase64Utf8, formatSize } from '@/lib/file-utils'
import { prepareMiniAppHtml } from '@/lib/mini-app'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, ChevronDown, PanelRight } from 'lucide-react'
import { useMemo, useState } from 'react'

export interface FilePreviewMeta {
	name: string
	mimeType: string
	sizeBytes: number
}

interface FilePreviewProps {
	workspaceId: string
	fileId: string
	/**
	 * What the caller already knows about the file. With it the card draws its header at once
	 * and fetches the bytes only when it opens (or straight away for a picture). Without it
	 * the file is fetched first to find out what it is.
	 */
	meta?: FilePreviewMeta
	/** Open the body straight away. A picture is always open: the picture is the preview. */
	defaultExpanded?: boolean
	className?: string
}

// Past these sizes the bytes are not worth shipping into a card; the viewer page is one click away.
const MAX_TEXT_BYTES = 1_500_000
const MAX_IMAGE_BYTES = 8_000_000

function typeLabel(mimeType: string): string {
	if (isHtml(mimeType)) return 'HTML page'
	if (isMarkdown(mimeType)) return 'Markdown'
	if (isInlineImage(mimeType)) return 'Image'
	if (isPlainText(mimeType)) return 'Text'
	return 'File'
}

/** Whether a card can draw this type at all. The rest show a header and a link to the viewer. */
export function isPreviewableFile(mimeType: string): boolean {
	return (
		isHtml(mimeType) || isMarkdown(mimeType) || isInlineImage(mimeType) || isPlainText(mimeType)
	)
}

function fileText(file: FileDetail): string {
	return file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
}

/**
 * A file drawn as a card, in chat and on For You: a rendered HTML page, formatted markdown,
 * the picture, or plain text. Scripts in an HTML page run in a sandboxed frame with the
 * platform CSP and no access to the app (the same frame the file viewer uses); SVG and other
 * types the browser would execute are shown as text or not at all, never rendered.
 */
export function FilePreview({
	workspaceId,
	fileId,
	meta,
	defaultExpanded = false,
	className,
}: FilePreviewProps) {
	const [open, setOpen] = useState(defaultExpanded)
	const linkedPanel = useLinkedPanel()
	// Without metadata from the caller, look the file up by id first: a list row is a few
	// hundred bytes, the file itself may be megabytes. An empty id list is a disabled query.
	const lookup = useFiles(workspaceId, { ids: meta ? [] : [fileId] })
	const listed = lookup.data?.[0]
	const known = meta ?? listed
	const knownImage = known ? isInlineImage(known.mimeType) : false
	const wantsBytes = Boolean(known) && (open || knownImage)
	const { data: file, isError } = useFile(workspaceId, wantsBytes ? fileId : null)

	// A file that is missing, or belongs to another workspace, shows nothing: the link in the
	// message is still there, so the card only ever adds. The same goes for the moment before
	// the lookup answers.
	if (!known) return null

	const { name, mimeType, sizeBytes } = known
	const isImage = isInlineImage(mimeType)
	const canOpen = isPreviewableFile(mimeType) && !isImage
	// A picture is the preview, so it is never folded; everything else opens on a click.
	const showBody = isImage || open

	return (
		<div
			data-linked-card=""
			className={cn(
				'@container not-prose mt-2 max-w-[660px] overflow-hidden rounded-xl border border-border bg-card',
				className,
			)}
		>
			<div
				className={cn('flex items-center gap-2 px-3 py-2', showBody && 'border-b border-border')}
			>
				{canOpen ? (
					<button
						type="button"
						aria-expanded={open}
						aria-label={`${open ? 'Contract' : 'Expand'} preview of ${name}`}
						onClick={() => setOpen((value) => !value)}
						className="flex min-w-0 flex-1 items-center gap-2 text-left"
					>
						<TypeChip label={typeLabel(mimeType)} />
						<span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
							{name}
						</span>
						<ChevronDown
							size={14}
							aria-hidden
							className={cn(
								'shrink-0 text-muted-foreground transition-transform',
								open && 'rotate-180',
							)}
						/>
					</button>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<TypeChip label={typeLabel(mimeType)} />
						<span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
							{name}
						</span>
					</div>
				)}
				<span className="hidden shrink-0 font-mono text-xs text-muted-foreground @sm:inline">
					{formatSize(sizeBytes)}
				</span>
				{linkedPanel ? (
					<button
						type="button"
						aria-label="Show in panel"
						title="Show in panel"
						onClick={(e) => {
							e.stopPropagation()
							linkedPanel.openLinked({ kind: 'file', id: fileId })
						}}
						className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:text-foreground"
					>
						<PanelRight size={14} aria-hidden />
					</button>
				) : null}
				<Link
					to="/$workspaceId/files/$fileId"
					params={{ workspaceId, fileId }}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<span className="sr-only @sm:not-sr-only">Open</span>
					<ArrowUpRight size={13} aria-hidden />
				</Link>
			</div>
			{showBody ? (
				<FileBodyPreview
					file={file}
					name={name}
					mimeType={mimeType}
					sizeBytes={sizeBytes}
					failed={isError}
				/>
			) : null}
		</div>
	)
}

function TypeChip({ label }: { label: string }) {
	// A narrow card keeps the type as its first word ("HTML page" becomes "HTML").
	const [first, ...rest] = label.split(' ')
	return (
		<span className="min-w-0 truncate rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
			{rest.length > 0 ? (
				<>
					<span className="@xs:hidden">{first}</span>
					<span className="hidden @xs:inline">{label}</span>
				</>
			) : (
				label
			)}
		</span>
	)
}

function FileBodyPreview({
	file,
	name,
	mimeType,
	sizeBytes,
	failed,
}: {
	file: FileDetail | undefined
	name: string
	mimeType: string | undefined
	sizeBytes: number | undefined
	failed: boolean
}) {
	if (failed) {
		return (
			<p role="alert" className="px-3 py-3 text-xs text-destructive">
				Could not load this file.
			</p>
		)
	}
	if (!file || !mimeType) {
		return (
			<div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
				<Spinner className="size-3" />
			</div>
		)
	}
	const limit = isInlineImage(mimeType) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
	if ((sizeBytes ?? file.sizeBytes) > limit) {
		return (
			<p className="px-3 py-3 text-xs text-muted-foreground">
				This file is too large to preview here. Open it to read it.
			</p>
		)
	}
	return <LoadedBody file={file} name={name} mimeType={mimeType} />
}

function LoadedBody({
	file,
	name,
	mimeType,
}: {
	file: FileDetail
	name: string
	mimeType: string
}) {
	// Hooks first: the body below branches on type, and the text is only needed for some.
	const text = useMemo(() => (isInlineImage(mimeType) ? '' : fileText(file)), [file, mimeType])
	const srcDoc = useMemo(() => (isHtml(mimeType) ? prepareMiniAppHtml(text) : ''), [text, mimeType])

	if (isInlineImage(mimeType)) {
		// <img> requests do not carry our bearer token, so the bytes go in as a data URI.
		const b64 = file.encoding === 'base64' ? file.content : btoa(file.content)
		return (
			<div className="bg-muted p-2">
				<img
					src={`data:${mimeType};base64,${b64}`}
					alt={name}
					className="mx-auto block max-h-96 w-auto max-w-full rounded object-contain"
				/>
			</div>
		)
	}
	if (isHtml(mimeType)) {
		// Scripts may run, but with no same-origin access: cookies, storage and the app's DOM
		// stay out of reach, and the platform CSP closes network egress from the frame.
		return (
			<iframe
				title={`Preview of ${name}`}
				srcDoc={srcDoc}
				sandbox="allow-scripts"
				className="block h-72 w-full border-0 bg-muted md:h-96"
			/>
		)
	}
	if (isMarkdown(mimeType)) {
		return (
			<div className="max-h-80 overflow-y-auto px-3 py-2 text-[13.5px]">
				<MarkdownContent content={text} size="sm" />
			</div>
		)
	}
	if (isPlainText(mimeType)) {
		return (
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted px-3 py-2 font-mono text-xs text-foreground">
				{text}
			</pre>
		)
	}
	return null
}
