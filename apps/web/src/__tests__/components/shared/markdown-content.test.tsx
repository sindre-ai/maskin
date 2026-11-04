import { MarkdownContent, parseFileViewerUrl } from '@/components/shared/markdown-content'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			files: {
				...actual.api.files,
				get: vi.fn(),
			},
		},
	}
})

vi.mock('recharts', async () => {
	const actual = await vi.importActual<typeof import('recharts')>('recharts')
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
			<div style={{ width: 600, height: 200 }}>{children}</div>
		),
	}
})

describe('MarkdownContent', () => {
	it('renders markdown content', () => {
		render(<MarkdownContent content="**bold text**" />)
		expect(screen.getByText('bold text')).toBeInTheDocument()
	})

	it('does not enter edit mode when not editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="read only" />)

		await user.click(screen.getByText('read only'))
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('opens an absolute link in a new tab so a click never navigates away', () => {
		render(<MarkdownContent content="See [the docs](https://example.com/docs) first." />)

		const link = screen.getByRole('link', { name: 'the docs' })
		expect(link).toHaveAttribute('href', 'https://example.com/docs')
		expect(link).toHaveAttribute('target', '_blank')
		expect(link).toHaveAttribute('rel', 'noopener noreferrer')
	})

	it('leaves a hash link on default target so in-page anchors still work', () => {
		render(<MarkdownContent content="See [the docs](#docs) first." />)

		const link = screen.getByRole('link', { name: 'the docs' })
		expect(link).toHaveAttribute('href', '#docs')
		expect(link).not.toHaveAttribute('target')
	})

	it('suppresses disallowed elements but keeps their text', () => {
		const { container } = render(
			<MarkdownContent
				content={'# Heading text\n\nbody'}
				disallowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']}
			/>,
		)
		expect(container.querySelector('h1')).toBeNull()
		expect(screen.getByText('Heading text')).toBeInTheDocument()
		expect(screen.getByText('body')).toBeInTheDocument()
	})

	it('renders a chart fenced block as a visual only when renderVisuals is on', () => {
		const spec = JSON.stringify({
			type: 'bar',
			x: 'day',
			series: ['v'],
			data: [{ day: 'Mon', v: 1 }],
			caption: 'visual-on',
		})
		const md = `before\n\n\`\`\`chart\n${spec}\n\`\`\`\n\nafter`

		const { rerender, container } = render(<MarkdownContent content={md} />)
		// renderVisuals defaults to false outside ActivityComment — the block
		// must stay a plain <pre><code> in object-document body markdown.
		expect(container.querySelector('pre')).not.toBeNull()
		expect(screen.queryByText('visual-on')).toBeNull()

		rerender(<MarkdownContent content={md} renderVisuals />)
		expect(screen.getByText('visual-on')).toBeInTheDocument()
		expect(container.querySelector('pre')).toBeNull()
	})

	it('shows the inline fallback note when a chart spec is malformed', () => {
		const md = 'lead\n\n```chart\n{not valid json\n```\n\ntail'
		render(<MarkdownContent content={md} renderVisuals />)
		expect(screen.getByText(/Couldn’t render chart/)).toBeInTheDocument()
		expect(screen.getByText('lead')).toBeInTheDocument()
		expect(screen.getByText('tail')).toBeInTheDocument()
	})

	// A wide markdown table (paste of a big table into chat) used to push the whole
	// chat window sideways because `overflow-x-auto` on the <table> element itself
	// doesn't clamp — the table's own intrinsic width from the table layout
	// algorithm can still exceed its containing block. The fix wraps every
	// rendered table in a block-level scroll container that DOES obey max-w-full.
	it('wraps a markdown table in a horizontal scroll container', () => {
		const table = '| a | b |\n| - | - |\n| 1 | 2 |'
		const { container } = render(<MarkdownContent content={table} />)
		const tableEl = container.querySelector('table')
		expect(tableEl).not.toBeNull()
		const wrapper = tableEl?.parentElement
		expect(wrapper?.className).toMatch(/overflow-x-auto/)
		expect(wrapper?.className).toMatch(/max-w-full/)
	})

	it('renders @mentions as chips inside formatted markdown', () => {
		const actors = [
			{
				id: 'a1',
				name: 'Magnus',
				type: 'human',
				email: null,
				description: null,
				isSystem: false,
				agentState: 'idle' as const,
			},
		]
		render(<MarkdownContent content="Hello @Magnus this is **important**" mentionActors={actors} />)
		const chip = screen.getByText('@Magnus')
		expect(chip.tagName).toBe('SPAN')
		const strong = screen.getByText('important')
		expect(strong.tagName).toBe('STRONG')
	})
})

describe('parseFileViewerUrl', () => {
	const ws = 'e2877e32-2c11-489e-96c8-a76200908ed4'
	const fid = '282b2497-5fa7-4639-ab71-cdc450db6e8b'

	it('matches an absolute maskin.io viewer URL', () => {
		expect(parseFileViewerUrl(`https://maskin.io/${ws}/files/${fid}`)).toEqual({
			workspaceId: ws,
			fileId: fid,
		})
	})

	it('matches a localhost viewer URL from a dev-minted description', () => {
		expect(parseFileViewerUrl(`http://localhost:5173/${ws}/files/${fid}`)).toEqual({
			workspaceId: ws,
			fileId: fid,
		})
	})

	it('matches a bare path (e.g. relative link inside the app)', () => {
		expect(parseFileViewerUrl(`/${ws}/files/${fid}`)).toEqual({
			workspaceId: ws,
			fileId: fid,
		})
	})

	it('returns null for URLs that are not file viewer routes', () => {
		expect(parseFileViewerUrl(`https://maskin.io/${ws}/objects/${fid}`)).toBeNull()
		expect(parseFileViewerUrl('https://example.com/cat.png')).toBeNull()
		expect(parseFileViewerUrl(undefined)).toBeNull()
		expect(parseFileViewerUrl('not-a-url')).toBeNull()
	})
})

describe('MarkdownContent — file viewer image swap', () => {
	const ws = 'e2877e32-2c11-489e-96c8-a76200908ed4'
	const fid = '282b2497-5fa7-4639-ab71-cdc450db6e8b'
	// Real image file (tiny 1x1 PNG) — the swap must inline these as data-URI.
	const png1x1 =
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

	it('inlines a maskin file viewer image URL as a data URI', async () => {
		const { api } = await import('@/lib/api')
		vi.mocked(api.files.get).mockResolvedValue({
			id: fid,
			workspaceId: ws,
			name: 'loop.png',
			description: null,
			mimeType: 'image/png',
			sizeBytes: 68,
			storageKey: `workspaces/${ws}/files/${fid}`,
			createdBy: 'a',
			createdAt: '2026-09-09T00:00:00Z',
			updatedAt: '2026-09-09T00:00:00Z',
			content: png1x1,
			encoding: 'base64',
			url: `https://maskin.io/${ws}/files/${fid}`,
			annotations: [],
		})

		render(
			<TestWrapper>
				<MarkdownContent content={`![loop](https://maskin.io/${ws}/files/${fid})`} />
			</TestWrapper>,
		)

		await waitFor(() => {
			const img = screen.getByAltText('loop')
			expect(img.getAttribute('src')).toBe(`data:image/png;base64,${png1x1}`)
		})
	})

	it('falls back to a link when the referenced file is not an inline-safe image', async () => {
		const { api } = await import('@/lib/api')
		vi.mocked(api.files.get).mockResolvedValue({
			id: fid,
			workspaceId: ws,
			name: 'unsafe.svg',
			description: null,
			mimeType: 'image/svg+xml',
			sizeBytes: 10,
			storageKey: `workspaces/${ws}/files/${fid}`,
			createdBy: 'a',
			createdAt: '2026-09-09T00:00:00Z',
			updatedAt: '2026-09-09T00:00:00Z',
			content: '',
			encoding: 'base64',
			url: `https://maskin.io/${ws}/files/${fid}`,
			annotations: [],
		})

		render(
			<TestWrapper>
				<MarkdownContent content={`![svg alt](https://maskin.io/${ws}/files/${fid})`} />
			</TestWrapper>,
		)

		const link = await screen.findByRole('link', { name: 'svg alt' })
		expect(link).toHaveAttribute('href', `/${ws}/files/${fid}`)
	})

	it('leaves external image URLs alone', () => {
		render(<MarkdownContent content="![cat](https://example.com/cat.png)" />)
		const img = screen.getByAltText('cat')
		expect(img.getAttribute('src')).toBe('https://example.com/cat.png')
	})
})
