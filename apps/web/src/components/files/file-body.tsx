import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import type { FileDetail } from '@/lib/api'

// MIME types whose bytes the browser would happily execute (or interpret as HTML)
// if we let them anywhere near `dangerouslySetInnerHTML` or an `<iframe srcDoc>`.
// We never render these inline — only as preformatted text + download.
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

export function FileBody({ file }: { file: FileDetail }) {
	if (isMarkdown(file.mimeType)) {
		return <MarkdownContent content={decodeBase64Utf8(file.content)} />
	}

	if (isInlineImage(file.mimeType)) {
		// Browsers don't send our Bearer token on <img src>, so use a data URI
		// from the base64 content we already loaded. SVG and other UNSAFE_INLINE
		// types never reach this branch.
		const src = `data:${file.mimeType};base64,${file.content}`
		return (
			<div className="rounded-md border border-border bg-bg-surface p-4">
				<img src={src} alt={file.name} className="max-w-full h-auto rounded" />
			</div>
		)
	}

	if (isPlainText(file.mimeType)) {
		// Preformatted text only — HTML/JS/SVG bytes are visible to the reader
		// but cannot execute in our origin because we never set innerHTML.
		const text = decodeBase64Utf8(file.content)
		return (
			<pre className="rounded-md border border-border bg-bg-surface p-4 text-xs font-mono whitespace-pre-wrap break-words overflow-x-auto text-text">
				{text}
			</pre>
		)
	}

	return (
		<EmptyState
			title="Preview not available"
			description={`Files of type ${file.mimeType} can't be previewed here. Use the Download button above to open them locally.`}
		/>
	)
}
