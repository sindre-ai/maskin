import {
	FileBody,
	isHtml,
	isInlineImage,
	isMarkdown,
	isPlainText,
} from '@/components/files/file-body'
import type { FileDetail } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function buildFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'doc.md',
		description: null,
		mimeType: 'text/markdown',
		sizeBytes: 16,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: '',
		url: 'http://localhost:5173/ws-1/files/file-1',
		...overrides,
	}
}

function b64(text: string): string {
	return Buffer.from(text, 'utf-8').toString('base64')
}

describe('FileBody', () => {
	describe('mime classification', () => {
		it('treats text/markdown as markdown', () => {
			expect(isMarkdown('text/markdown')).toBe(true)
			expect(isMarkdown('text/plain')).toBe(false)
		})

		it('treats text/html and application/xhtml+xml as HTML', () => {
			expect(isHtml('text/html')).toBe(true)
			expect(isHtml('application/xhtml+xml')).toBe(true)
			expect(isHtml('text/plain')).toBe(false)
			expect(isHtml('text/markdown')).toBe(false)
		})

		it('treats HTML as plain text fallback and not as an inline image', () => {
			// HTML is renderable via the sandboxed iframe path, but it must still
			// fall through to text classification if iframe rendering is bypassed.
			expect(isPlainText('text/html')).toBe(true)
			expect(isInlineImage('text/html')).toBe(false)
			expect(isMarkdown('text/html')).toBe(false)
		})

		it('treats SVG as plain text, not as an inline image', () => {
			// SVGs can execute scripts — must never end up in <img> with the
			// browser parsing them as XML in our origin.
			expect(isInlineImage('image/svg+xml')).toBe(false)
			expect(isPlainText('image/svg+xml')).toBe(true)
		})

		it('treats safe image mime types as inline images', () => {
			expect(isInlineImage('image/png')).toBe(true)
			expect(isInlineImage('image/jpeg')).toBe(true)
			expect(isInlineImage('image/webp')).toBe(true)
		})

		it('treats JS as plain text, not inline', () => {
			expect(isPlainText('application/javascript')).toBe(true)
			expect(isInlineImage('application/javascript')).toBe(false)
		})
	})

	describe('rendering', () => {
		it('renders markdown content via react-markdown by default', () => {
			const file = buildFile({ mimeType: 'text/markdown', content: b64('# Hello world') })
			render(<FileBody file={file} />)
			expect(screen.getByRole('heading', { level: 1, name: 'Hello world' })).toBeInTheDocument()
		})

		it('switches markdown view to raw source when Source is selected', () => {
			const file = buildFile({ mimeType: 'text/markdown', content: b64('# Hello world') })
			const { container } = render(<FileBody file={file} />)
			fireEvent.click(screen.getByRole('button', { name: 'Source' }))

			const pre = container.querySelector('pre')
			expect(pre?.textContent).toBe('# Hello world')
			// Rendered heading should be gone.
			expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
		})

		it('renders an <img> with a data URI for safe image mime types', () => {
			// Browsers don't send our Bearer token on <img src>, so the inline
			// preview must use the base64 content directly instead of the API URL.
			const pngB64 = b64('fake-png-bytes')
			const file = buildFile({
				mimeType: 'image/png',
				name: 'icon.png',
				content: pngB64,
			})
			render(<FileBody file={file} />)
			const img = screen.getByRole('img', { name: 'icon.png' })
			expect(img).toHaveAttribute('src', `data:image/png;base64,${pngB64}`)
		})

		it('renders HTML inside a sandboxed iframe via srcDoc', () => {
			const html = '<script>window.__pwned = true</script><h1>Heading</h1>'
			const file = buildFile({ mimeType: 'text/html', name: 'page.html', content: b64(html) })
			const { container } = render(<FileBody file={file} />)

			const iframe = container.querySelector('iframe')
			expect(iframe).not.toBeNull()
			// `srcdoc` carries the file bytes — the iframe is the only place the
			// HTML is parsed. Browser maps the React `srcDoc` prop to lowercase.
			expect(iframe?.getAttribute('srcdoc')).toBe(html)
			// Sandbox isolates the page: scripts may run inside but cannot reach
			// our origin. `allow-same-origin` must NOT be present.
			const sandbox = iframe?.getAttribute('sandbox') ?? ''
			expect(sandbox).toContain('allow-scripts')
			expect(sandbox).not.toContain('allow-same-origin')

			// The script in the HTML must not have been parsed into our document.
			expect(container.querySelector('script')).toBeNull()
			expect(screen.queryByRole('heading')).not.toBeInTheDocument()
		})

		it('switches HTML view to raw source when Source is selected', () => {
			const html = '<h1>Heading</h1>'
			const file = buildFile({ mimeType: 'text/html', name: 'page.html', content: b64(html) })
			const { container } = render(<FileBody file={file} />)
			fireEvent.click(screen.getByRole('button', { name: 'Source' }))

			expect(container.querySelector('iframe')).toBeNull()
			expect(container.querySelector('pre')?.textContent).toBe(html)
		})

		it('renders SVG as preformatted text (NOT as an inline image)', () => {
			const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
			const file = buildFile({ mimeType: 'image/svg+xml', name: 'icon.svg', content: b64(svg) })
			const { container } = render(<FileBody file={file} />)

			expect(container.querySelector('pre')?.textContent).toBe(svg)
			expect(container.querySelector('svg')).toBeNull()
			expect(container.querySelector('script')).toBeNull()
		})

		it('renders JavaScript as preformatted text', () => {
			const js = 'window.__pwned = true; alert("xss")'
			const file = buildFile({
				mimeType: 'application/javascript',
				name: 'app.js',
				content: b64(js),
			})
			const { container } = render(<FileBody file={file} />)
			expect(container.querySelector('pre')?.textContent).toBe(js)
			expect(container.querySelector('script')).toBeNull()
		})

		it('falls back to a "preview not available" empty state for unknown types', () => {
			const file = buildFile({ mimeType: 'application/pdf', name: 'doc.pdf' })
			render(<FileBody file={file} />)
			expect(screen.getByText('Preview not available')).toBeInTheDocument()
		})
	})
})
