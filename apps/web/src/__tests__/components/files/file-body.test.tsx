import { FileBody, isInlineImage, isMarkdown, isPlainText } from '@/components/files/file-body'
import type { FileDetail } from '@/lib/api'
import { render, screen } from '@testing-library/react'
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
		downloadUrl: 'http://localhost:5173/api/files/file-1/download',
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

		it('treats text/html as plain text, not inline-renderable', () => {
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
		it('renders markdown content via react-markdown', () => {
			const file = buildFile({ mimeType: 'text/markdown', content: b64('# Hello world') })
			render(<FileBody file={file} />)
			expect(screen.getByRole('heading', { level: 1, name: 'Hello world' })).toBeInTheDocument()
		})

		it('renders an <img> for safe image mime types', () => {
			const file = buildFile({
				mimeType: 'image/png',
				name: 'icon.png',
				downloadUrl: 'http://localhost/api/files/file-1/download',
			})
			render(<FileBody file={file} />)
			const img = screen.getByRole('img', { name: 'icon.png' })
			expect(img).toHaveAttribute('src', 'http://localhost/api/files/file-1/download')
		})

		it('renders HTML as preformatted text (NOT as HTML)', () => {
			const html = '<script>window.__pwned = true</script><h1>Heading</h1>'
			const file = buildFile({ mimeType: 'text/html', name: 'page.html', content: b64(html) })
			const { container } = render(<FileBody file={file} />)

			// The literal source must be visible as text.
			const pre = container.querySelector('pre')
			expect(pre).not.toBeNull()
			expect(pre?.textContent).toBe(html)

			// No script element should have ended up in the DOM.
			expect(container.querySelector('script')).toBeNull()
			// No heading should have been parsed from the HTML — the bytes are text.
			expect(screen.queryByRole('heading')).not.toBeInTheDocument()
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
