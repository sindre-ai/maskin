import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import type { FileDetail } from '@/lib/api'
import { Pin } from 'lucide-react'
import { useState } from 'react'
import { AnnotationOverlay } from './annotation-overlay'

// MIME types whose bytes the browser would happily execute (or interpret as HTML)
// if we let them anywhere near `dangerouslySetInnerHTML` or an `<img src>`. HTML
// is handled via a sandboxed iframe below; the rest are rendered as text only.
export const UNSAFE_INLINE_MIME = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/javascript',
	'text/javascript',
	'application/ecmascript',
	'text/ecmascript',
])

export function isMarkdown(mimeType: string): boolean {
	return mimeType === 'text/markdown' || mimeType === 'text/x-markdown'
}

export function isHtml(mimeType: string): boolean {
	return mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
}

export function isInlineImage(mimeType: string): boolean {
	return mimeType.startsWith('image/') && !UNSAFE_INLINE_MIME.has(mimeType)
}

export function isPlainText(mimeType: string): boolean {
	if (UNSAFE_INLINE_MIME.has(mimeType)) return true // shown as preformatted text, never rendered
	return (
		mimeType.startsWith('text/') ||
		mimeType === 'application/json' ||
		mimeType === 'application/yaml' ||
		mimeType === 'application/xml' ||
		mimeType === 'application/x-yaml'
	)
}

export function base64ToBytes(base64: string): Uint8Array {
	if (typeof atob === 'undefined') return new Uint8Array()
	try {
		const binary = atob(base64)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return bytes
	} catch {
		return new Uint8Array()
	}
}

export function decodeBase64Utf8(base64: string): string {
	const bytes = base64ToBytes(base64)
	if (bytes.length === 0) return ''
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

type ViewMode = 'rendered' | 'source'

function SourceView({ text }: { text: string }) {
	return (
		<pre className="rounded-md border border-border bg-bg-surface p-4 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto text-text">
			{text}
		</pre>
	)
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
	const options: { value: ViewMode; label: string }[] = [
		{ value: 'rendered', label: 'Rendered' },
		{ value: 'source', label: 'Source' },
	]
	return (
		<ButtonGroup>
			{options.map((opt) => (
				<Button
					key={opt.value}
					type="button"
					variant={mode === opt.value ? 'secondary' : 'ghost'}
					size="sm"
					onClick={() => onChange(opt.value)}
				>
					{opt.label}
				</Button>
			))}
		</ButtonGroup>
	)
}

function HtmlPreview({ html, name }: { html: string; name: string }) {
	// `srcdoc` + `sandbox` isolate the page: scripts may run inside the iframe
	// but cannot reach our origin's cookies, storage, or DOM. We deliberately
	// omit `allow-same-origin`, so fetch/XHR from the page sees a null origin
	// and same-origin checks against our app fail closed.
	//
	// The wrapper carries `resize` so the user gets a native CSS drag-handle
	// in the bottom-right corner that grows it both vertically and horizontally;
	// the iframe fills it. `overflow-hidden` is required for `resize` to take
	// effect on a block element. The `max-w` lets the user pull the preview
	// past the page's narrower container, up to roughly the viewport width.
	return (
		<div className="resize overflow-hidden rounded-md border border-border bg-bg-surface w-full h-[60vh] min-h-[20vh] max-h-[200vh] max-w-[calc(100vw-4rem)]">
			<iframe
				title={`Preview of ${name}`}
				srcDoc={html}
				sandbox="allow-scripts"
				className="w-full h-full block"
			/>
		</div>
	)
}

function fileText(file: FileDetail): string {
	return file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
}

export function FileBody({ file }: { file: FileDetail }) {
	const [mode, setMode] = useState<ViewMode>('rendered')
	const [annotateMode, setAnnotateMode] = useState(false)

	if (isMarkdown(file.mimeType)) {
		const text = fileText(file)
		return (
			<div className="space-y-3">
				<div className="flex justify-end">
					<ViewToggle mode={mode} onChange={setMode} />
				</div>
				{mode === 'rendered' ? <MarkdownContent content={text} /> : <SourceView text={text} />}
			</div>
		)
	}

	if (isHtml(file.mimeType)) {
		const text = fileText(file)
		return (
			<div className="space-y-3">
				<div className="flex items-center justify-end gap-2">
					{mode === 'rendered' && (
						<Button
							type="button"
							variant={annotateMode ? 'secondary' : 'ghost'}
							size="sm"
							onClick={() => setAnnotateMode((v) => !v)}
						>
							<Pin size={14} />
							{annotateMode ? 'Exit annotate' : 'Annotate'}
						</Button>
					)}
					<ViewToggle
						mode={mode}
						onChange={(m) => {
							setMode(m)
							setAnnotateMode(false)
						}}
					/>
				</div>
				{mode === 'rendered' ? (
					annotateMode ? (
						<AnnotationOverlay html={text} name={file.name} />
					) : (
						<HtmlPreview html={text} name={file.name} />
					)
				) : (
					<SourceView text={text} />
				)}
			</div>
		)
	}

	if (isInlineImage(file.mimeType)) {
		// Browsers don't send our Bearer token on <img src>, so use a data URI
		// from the base64 content. Images always come back with encoding='base64'
		// since they aren't text-MIME types — but guard anyway in case the
		// server ever returns utf8 for a binary type.
		const b64 = file.encoding === 'base64' ? file.content : btoa(file.content)
		const src = `data:${file.mimeType};base64,${b64}`
		return (
			<div className="rounded-md border border-border bg-bg-surface p-4">
				<img src={src} alt={file.name} className="max-w-full h-auto rounded" />
			</div>
		)
	}

	if (isPlainText(file.mimeType)) {
		// Preformatted text only — JS/SVG bytes are visible to the reader but
		// cannot execute in our origin because we never set innerHTML.
		return <SourceView text={fileText(file)} />
	}

	return (
		<EmptyState
			title="Preview not available"
			description={`Files of type ${file.mimeType} can't be previewed here. Use the Download button above to open them locally.`}
		/>
	)
}
