import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import type { ObjectPreview } from '@maskin/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
})
