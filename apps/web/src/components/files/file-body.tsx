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

export function decodeBase64Utf8(base64: string): string {
	if (typeof atob === 'undefined') return ''
	try {
		const binary = atob(base64)
		const bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
	} catch {
		return ''
	}
}

export function FileBody({ file }: { file: FileDetail }) {
	if (isMarkdown(file.mimeType)) {
		return <MarkdownContent content={decodeBase64Utf8(file.content)} />
	}

	if (isInlineImage(file.mimeType)) {
		// The download endpoint sets `inline` disposition for non-script image
		// mime types — SVG and other UNSAFE_INLINE types never reach this branch.
		return (
			<div className="rounded-md border border-border bg-bg-surface p-4">
				<img src={file.downloadUrl} alt={file.name} className="max-w-full h-auto rounded" />
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
