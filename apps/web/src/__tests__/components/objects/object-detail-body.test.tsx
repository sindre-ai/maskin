import { ObjectDetailBody } from '@/components/objects/object-detail-body'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

describe('ObjectDetailBody', () => {
	it('renders markdown headings, paragraphs and list items', () => {
		const object = buildObjectResponse({
			content: '# Heading\n\nSome paragraph text.\n\n- item one\n- item two',
		})
		render(<ObjectDetailBody object={object} />)

		expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
		expect(screen.getByText('Some paragraph text.')).toBeInTheDocument()
		expect(screen.getByText('item one')).toBeInTheDocument()
		expect(screen.getByText('item two')).toBeInTheDocument()
	})

	it('renders non-`_` metadata as key/value rows and hides `_` fixture keys', () => {
		const object = buildObjectResponse({
			metadata: { segment: 'enterprise', _ask_title: 'hidden fixture key' },
		})
		render(<ObjectDetailBody object={object} />)

		expect(screen.getByText('segment:')).toBeInTheDocument()
		expect(screen.getByText('enterprise')).toBeInTheDocument()
		expect(screen.queryByText('hidden fixture key')).not.toBeInTheDocument()
	})

	it('renders nothing when the object has no content and no metadata', () => {
		const { container } = render(<ObjectDetailBody object={buildObjectResponse()} />)
		expect(container.querySelector('.prose')).not.toBeInTheDocument()
		expect(container.querySelector('button')).not.toBeInTheDocument()
	})

	it('renders the collapsible document fold and reveals its markdown on toggle', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({
			metadata: { _fold_title: 'Notes', _fold_markdown: '## Fold heading' },
		})
		render(<ObjectDetailBody object={object} />)

		expect(screen.queryByRole('heading', { name: 'Fold heading' })).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /notes/i }))
		expect(screen.getByRole('heading', { name: 'Fold heading' })).toBeInTheDocument()
	})

	it('renders the evidence block behind its own fold', async () => {
		const user = userEvent.setup()
		const object = buildObjectResponse({
			metadata: {
				_evidence_quote: 'The claim is backed',
				_evidence_source: 'Source #1',
				_evidence_date: '2026-08-01',
			},
		})
		render(<ObjectDetailBody object={object} />)

		expect(screen.queryByText(/The claim is backed/)).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: /evidence/i }))
		expect(screen.getByText(/The claim is backed/)).toBeInTheDocument()
		expect(screen.getByText('Source #1')).toBeInTheDocument()
	})
})
