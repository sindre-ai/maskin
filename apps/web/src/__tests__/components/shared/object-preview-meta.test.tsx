import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import type { ObjectPreview } from '@maskin/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

function buildPreview(overrides: Partial<ObjectPreview> = {}): ObjectPreview {
	return {
		kind: 'email',
		label: 'Email',
		provider: 'gmail',
		recipients: [
			{ role: 'to', name: 'Mette Holm', address: 'mette@northwind.dk' },
			{ role: 'cc', name: null, address: 'dan@northwind.dk' },
		],
		subject: 'Thursday',
		details: [],
		body: 'Hi Mette',
		maxLength: null,
		missing: [],
		warnings: [],
		content_hash: 'hash',
		...overrides,
	}
}

describe('ObjectPreviewMeta', () => {
	it('shows recipients with name and address, and the subject', () => {
		render(<ObjectPreviewMeta preview={buildPreview()} />)
		expect(screen.getByText('Mette Holm <mette@northwind.dk>')).toBeInTheDocument()
		expect(screen.getByText('dan@northwind.dk')).toBeInTheDocument()
		expect(screen.getByText('Thursday')).toBeInTheDocument()
	})

	it('names what is missing and repeats each warning', () => {
		render(
			<ObjectPreviewMeta
				preview={buildPreview({
					recipients: [],
					subject: null,
					missing: ['To', 'Subject'],
					warnings: ['The text is 5 characters over the 100 limit.'],
				})}
			/>,
		)
		const alerts = screen.getAllByRole('alert').map((el) => el.textContent)
		expect(alerts).toEqual(['Missing: To, Subject', 'The text is 5 characters over the 100 limit.'])
	})

	it('renders nothing for a preview with no fields to show', () => {
		const { container } = render(
			<ObjectPreviewMeta preview={buildPreview({ recipients: [], subject: null })} />,
		)
		expect(container).toBeEmptyDOMElement()
	})
	it('shows the detail lines of a kind that is not an email', () => {
		render(
			<ObjectPreviewMeta
				preview={buildPreview({
					kind: 'linkedin_post',
					label: 'LinkedIn post',
					recipients: [],
					subject: null,
					details: [
						{ label: 'Posting as', value: 'sebk_personal' },
						{ label: 'Scheduled', value: '2026-10-27' },
					],
				})}
			/>,
		)
		expect(screen.getByText('Posting as')).toBeInTheDocument()
		expect(screen.getByText('sebk_personal')).toBeInTheDocument()
		expect(screen.getByText('2026-10-27')).toBeInTheDocument()
	})

	it('reads a preview from an older response that has no detail lines', () => {
		const { details: _omitted, ...older } = buildPreview()
		render(<ObjectPreviewMeta preview={older as ObjectPreview} />)
		expect(screen.getByText('Thursday')).toBeInTheDocument()
	})

	describe('the message a reply answers', () => {
		afterEach(() => vi.restoreAllMocks())

		function overflowBy(scrollHeight: number, clientHeight: number) {
			vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight)
			vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight)
		}

		it('shows it as a quote above the details', () => {
			render(<ObjectPreviewMeta preview={buildPreview({ context: 'Can we meet Thursday?' })} />)
			expect(screen.getByText('In reply to')).toBeInTheDocument()
			expect(screen.getByText('Can we meet Thursday?')).toBeInTheDocument()
		})

		it('has no quote and no toggle without one', () => {
			render(<ObjectPreviewMeta preview={buildPreview()} />)
			expect(screen.queryByText('In reply to')).not.toBeInTheDocument()
			expect(screen.queryByRole('button')).not.toBeInTheDocument()
		})

		it('offers no toggle when the quote fits', () => {
			overflowBy(60, 60)
			render(<ObjectPreviewMeta preview={buildPreview({ context: 'Short' })} />)
			expect(screen.queryByRole('button')).not.toBeInTheDocument()
		})

		it('opens a long quote in full and closes it again', () => {
			overflowBy(200, 100)
			render(<ObjectPreviewMeta preview={buildPreview({ context: 'A very long email' })} />)
			const quote = screen.getByText('A very long email')
			expect(quote).toHaveClass('line-clamp-5')

			fireEvent.click(screen.getByRole('button', { name: /show more/i }))
			expect(quote).not.toHaveClass('line-clamp-5')
			expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute(
				'aria-expanded',
				'true',
			)

			fireEvent.click(screen.getByRole('button', { name: /show less/i }))
			expect(quote).toHaveClass('line-clamp-5')
		})
	})
})
