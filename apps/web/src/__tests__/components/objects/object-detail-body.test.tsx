import { ObjectDetailBody } from '@/components/objects/object-detail-body'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

// MarkdownContent renders raw text so assertions read the fixture words directly.
vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

describe('ObjectDetailBody', () => {
	it('renders object content markdown', () => {
		const object = buildObjectResponse({ content: '## Heading\n\nSome paragraph' })
		render(<ObjectDetailBody object={object} />)
		expect(screen.getByText(/## Heading/)).toBeInTheDocument()
		expect(screen.getByText(/Some paragraph/)).toBeInTheDocument()
	})

	it('renders key/value rows for public metadata entries', () => {
		const object = buildObjectResponse({
			metadata: { priority: 'high', team: 'alpha', _hidden: 'secret' },
		})
		render(<ObjectDetailBody object={object} />)
		expect(screen.getByText('priority')).toBeInTheDocument()
		expect(screen.getByText('high')).toBeInTheDocument()
		expect(screen.getByText('team')).toBeInTheDocument()
		expect(screen.getByText('alpha')).toBeInTheDocument()
		// Underscore-prefixed fixture keys stay out of the kv rows
		expect(screen.queryByText('_hidden')).not.toBeInTheDocument()
	})

	it('skips kv rows when only underscore keys exist', () => {
		const object = buildObjectResponse({ metadata: { _ask: 'question?' } })
		const { container } = render(<ObjectDetailBody object={object} />)
		expect(container.querySelector('dl')).toBeNull()
	})

	it('renders the document fold collapsed, expanding on click', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({
			metadata: { _fold_title: 'Research notes', _fold_markdown: '# Notes\n\nBody text' },
		})
		render(<ObjectDetailBody object={object} />)

		expect(screen.getByText('Research notes')).toBeInTheDocument()
		expect(screen.queryByText(/Body text/)).not.toBeInTheDocument()

		await user.click(screen.getByText('Research notes'))
		expect(screen.getByText(/Body text/)).toBeInTheDocument()
	})

	it('renders the evidence block when evidence quote is present', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({
			metadata: { _evidence_quote: 'A source quote', _evidence_source: 'Slack #general' },
		})
		render(<ObjectDetailBody object={object} />)

		await user.click(screen.getByText('Evidence'))
		expect(screen.getByText('A source quote')).toBeInTheDocument()
		expect(screen.getByText('Slack #general')).toBeInTheDocument()
	})
})
