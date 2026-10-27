import { MarkdownContent } from '@/components/shared/markdown-content'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TestWrapper } from '../../setup'

// Which ids the stand-in resolves to a card: drafts and previewable files. Any other object gets
// a reference card in a paragraph, nothing under a sentence and its link in a list, and its link
// is drawn as a chip. The real components decide this from the fetched object or file (covered in
// linked-object-preview.test.tsx); here only placement is under test.
let qualifying = new Set<string>()
const renderCard = (
	target: { kind: string; id: string },
	fallback: ReactNode,
	context: { label?: string; inList?: boolean; after?: boolean; updated?: boolean },
) => {
	if (qualifying.has(target.id)) {
		return (
			<>
				{context.label && context.inList ? <p>{context.label}</p> : null}
				<div data-testid="card" data-updated={context.updated ? '' : undefined}>
					{`${target.kind}:${target.id}`}
				</div>
			</>
		)
	}
	if (target.kind === 'object' && !context.after && !context.inList) {
		return (
			<>
				{context.label ? <p>{context.label}</p> : null}
				<div data-testid="reference">{target.id}</div>
			</>
		)
	}
	return context.after ? null : <>{fallback}</>
}
const renderChip = (target: { kind: string; id: string }, fallback: ReactNode) =>
	qualifying.has(target.id) ? (
		fallback
	) : (
		<span data-testid="chip" data-id={target.id}>
			{fallback}
		</span>
	)

const WS = 'ws-1'
const A = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const B = 'b8278eef-4a95-43df-911e-3cb3473a55fb'
const FILE = '5e0c0f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6'
const objectUrl = (id: string) => `https://maskin.io/${WS}/objects/${id}`
const fileUrl = (id: string) => `https://maskin.io/${WS}/files/${id}`

const hasOwnCard = (item: HTMLElement) =>
	Array.from(item.children).some((child) => child.getAttribute('data-testid') === 'card')

function renderMessage(
	content: string,
	withCards = true,
	skipIds?: ReadonlySet<string>,
	updatedIds?: ReadonlySet<string>,
) {
	return render(
		<MarkdownContent
			content={content}
			size="sm"
			linkedCards={
				withCards ? { workspaceId: WS, renderCard, renderChip, skipIds, updatedIds } : undefined
			}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('MarkdownContent linkedCards', () => {
	beforeEach(() => {
		qualifying = new Set([A, B, FILE])
	})

	it('replaces a paragraph that is only a link by its card and drops the link text', () => {
		renderMessage(`Here you go.\n\n[Email to Torben](${objectUrl(A)})`)
		expect(screen.getByTestId('card')).toHaveTextContent(`object:${A}`)
		expect(screen.queryByText('Email to Torben')).not.toBeInTheDocument()
		expect(screen.getByText('Here you go.')).toBeInTheDocument()
	})

	it('tolerates a short label and trailing punctuation', () => {
		renderMessage(`Draft: [Email to Torben](${objectUrl(A)}).`)
		expect(screen.getByTestId('card')).toBeInTheDocument()
		expect(screen.queryByText(/Draft:/)).not.toBeInTheDocument()
	})

	it('tolerates a bold label and a bold link', () => {
		renderMessage(`**Draft:** **[Email to Torben](${objectUrl(A)})**`)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
	})

	it('draws a list item that is only a link inside the list item', () => {
		renderMessage(`- [One](${objectUrl(A)})\n- [Two](${objectUrl(B)})`)
		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(2)
		for (const item of items) expect(item.querySelector('[data-testid=card]')).not.toBeNull()
	})

	it('draws a linked page the same way as a draft', () => {
		renderMessage(`[The page](${fileUrl(FILE)})`)
		expect(screen.getByTestId('card')).toHaveTextContent(`file:${FILE}`)
	})

	it('keeps a link inside a sentence and puts its card under the message', () => {
		const { container } = renderMessage(`I wrote [the email](${objectUrl(A)}) for you.`)
		expect(screen.getByRole('link', { name: 'the email' })).toBeInTheDocument()
		const card = screen.getByTestId('card')
		const paragraph = container.querySelector('p')
		expect(paragraph?.compareDocumentPosition(card)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
	})

	it('does not draw an id again below when it was drawn in place', () => {
		renderMessage(`[Email](${objectUrl(A)})\n\nSee also [the email](${objectUrl(A)}) above.`)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
	})

	it('draws a card below for each in-sentence object link, three at most', () => {
		const D = '9d3c9f10-1111-4222-8333-444455556666'
		const E = '1e2d3c4b-5555-4666-8777-888899990000'
		qualifying = new Set([A, B, D, E])
		renderMessage(
			`Look at [a](${objectUrl(A)}), [b](${objectUrl(B)}), [d](${objectUrl(D)}) and [e](${objectUrl(E)}).`,
		)
		expect(screen.getAllByTestId('card')).toHaveLength(3)
	})

	it('draws a standalone link to any other object as a reference card, not a chip', () => {
		qualifying = new Set()
		renderMessage(`[A contact](${objectUrl(A)})`)
		expect(screen.getByTestId('reference')).toHaveTextContent(A)
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
		expect(screen.queryByTestId('chip')).not.toBeInTheDocument()
	})

	it('draws a link in a sentence as a chip and adds nothing after the paragraph', () => {
		qualifying = new Set()
		const { container } = renderMessage(`I wrote [the email](${objectUrl(A)}) for you.`)
		expect(screen.getByTestId('chip')).toContainElement(
			screen.getByRole('link', { name: 'the email' }),
		)
		expect(screen.queryByTestId('reference')).not.toBeInTheDocument()
		expect(container.querySelectorAll('p')).toHaveLength(1)
	})

	it('keeps a draft linked in a sentence a plain link, with its card under the paragraph', () => {
		renderMessage(`I wrote [the email](${objectUrl(A)}) for you.`)
		expect(screen.queryByTestId('chip')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'the email' })).toBeInTheDocument()
		expect(screen.getByTestId('card')).toBeInTheDocument()
	})

	it('keeps the order of a sentence, a link on its own line, and a sentence', () => {
		qualifying = new Set()
		renderMessage(`Before it.\n[Email](${objectUrl(A)})\nAfter it.`)
		const card = screen.getByTestId('reference')
		expect(screen.getByText(/Before it\./).compareDocumentPosition(card)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
		expect(card.compareDocumentPosition(screen.getByText(/After it\./))).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
		expect(screen.queryByTestId('chip')).not.toBeInTheDocument()
	})

	it('leaves a line with other words around its link a chip', () => {
		qualifying = new Set()
		renderMessage(`Before it.\nSee [Email](${objectUrl(A)}) now.\nAfter it.`)
		expect(screen.queryByTestId('reference')).not.toBeInTheDocument()
		expect(screen.getByTestId('chip')).toBeInTheDocument()
	})

	it('keeps a short lead-in on the line before the card as text', () => {
		qualifying = new Set()
		renderMessage(`Next up: [Email](${objectUrl(A)})`)
		expect(screen.getByText(/Next up:/)).toBeInTheDocument()
		expect(screen.getByTestId('reference')).toBeInTheDocument()
	})

	it('draws three objects on their own lines as cards and the fourth as a chip', () => {
		const D = '9d3c9f10-1111-4222-8333-444455556666'
		const E = '1e2d3c4b-5555-4666-8777-888899990000'
		qualifying = new Set()
		renderMessage([A, B, D, E].map((id) => `[x](${objectUrl(id)})`).join('\n\n'))
		expect(screen.getAllByTestId('reference')).toHaveLength(3)
		expect(screen.getByTestId('chip')).toHaveAttribute('data-id', E)
	})

	it('draws a second link to the same object as a chip', () => {
		qualifying = new Set()
		renderMessage(`[Email](${objectUrl(A)})\n\n[Email again](${objectUrl(A)})`)
		expect(screen.getAllByTestId('reference')).toHaveLength(1)
		expect(screen.getAllByTestId('chip')).toHaveLength(1)
	})

	it('draws a link to an object an earlier message shows as a chip', () => {
		qualifying = new Set()
		renderMessage(`[Email](${objectUrl(A)})`, true, new Set([A]))
		expect(screen.queryByTestId('reference')).not.toBeInTheDocument()
		expect(screen.getByTestId('chip')).toBeInTheDocument()
	})

	it('only the first ten objects are looked up; later links stay plain links', () => {
		qualifying = new Set()
		const ids = Array.from(
			{ length: 12 },
			(_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
		)
		renderMessage(ids.map((id, i) => `See [n${i}](${objectUrl(id)}) here.`).join('\n\n'))
		expect(screen.getAllByTestId('chip')).toHaveLength(10)
		expect(screen.getAllByRole('link')).toHaveLength(12)
	})

	it('keeps a standalone link and its list item while the card is not known yet', () => {
		qualifying = new Set()
		renderMessage(`- [One](${objectUrl(A)})`)
		expect(screen.getByRole('listitem')).toContainElement(screen.getByRole('link', { name: 'One' }))
	})

	it('leaves a link with other text in its paragraph alone, even with a long lead-in', () => {
		qualifying = new Set()
		renderMessage(
			`This is a much longer introduction than any label would ever be allowed to be: [x](${objectUrl(A)})`,
		)
		expect(screen.getByRole('link', { name: 'x' })).toBeInTheDocument()
	})

	it('keeps the label of a list item as text beside its card', () => {
		renderMessage(`- Draft: [Email](${objectUrl(A)})`)
		expect(screen.getByTestId('card')).toBeInTheDocument()
		expect(screen.getByText('Draft:')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: 'Email' })).not.toBeInTheDocument()
	})

	it('treats a loose list like a tight one', () => {
		renderMessage(`- [One](${objectUrl(A)})\n\n- [Two](${objectUrl(B)})`)
		expect(screen.getAllByTestId('card')).toHaveLength(2)
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('draws cards in nested and ordered lists, each in its own item', () => {
		renderMessage(`1. [One](${objectUrl(A)})\n   - [Two](${objectUrl(B)})\n2. Plain item`)
		const items = screen.getAllByRole('listitem')
		expect(items).toHaveLength(3)
		expect(hasOwnCard(items[0])).toBe(true)
		expect(hasOwnCard(items[1])).toBe(true)
		expect(screen.getAllByTestId('card')).toHaveLength(2)
	})

	it('leaves an item with text around its link alone', () => {
		renderMessage(`- Please review [One](${objectUrl(A)}) today`)
		expect(screen.getByRole('link', { name: 'One' })).toBeInTheDocument()
	})

	it('keeps a link in a heading, a quote or a table a link', () => {
		for (const text of [
			`## [Title](${objectUrl(A)})`,
			`> [Quoted](${objectUrl(A)})`,
			`| a |\n| - |\n| [Cell](${objectUrl(A)}) |`,
		]) {
			const { unmount, container } = renderMessage(text)
			expect(container.querySelector('a')).not.toBeNull()
			unmount()
		}
	})

	it('draws nothing for an address in a code span or a code block', () => {
		renderMessage(`Use \`${objectUrl(A)}\` as is.\n\n\`\`\`\n${objectUrl(B)}\n\`\`\``)
		expect(screen.queryByTestId('card')).not.toBeInTheDocument()
	})

	it('draws an id once when it is both standalone and in a sentence', () => {
		renderMessage(`[Email](${objectUrl(A)})\n\nI wrote [it](${objectUrl(A)}) today.`)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
	})

	it('draws the sentence mention of a card already drawn as a chip', () => {
		qualifying = new Set()
		renderMessage(`[Email](${objectUrl(A)})\n\nI wrote [it](${objectUrl(A)}) today.`)
		expect(screen.getAllByTestId('reference')).toHaveLength(1)
		expect(screen.getByTestId('chip')).toBeInTheDocument()
	})

	it('puts the card of a link in a sentence right after that paragraph, not at the end', () => {
		renderMessage(`Before.\n\nSee [it](${objectUrl(A)}) now.\n\nAfter.`)
		const card = screen.getByTestId('card')
		expect(screen.getByText('Before.').compareDocumentPosition(card)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
		expect(card.compareDocumentPosition(screen.getByText('After.'))).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
	})

	it('puts each card after its own paragraph, files included', () => {
		renderMessage(`One [a](${objectUrl(A)}).\n\nTwo [f](${fileUrl(FILE)}).\n\nEnd.`)
		const [first, second] = screen.getAllByTestId('card')
		expect(first).toHaveTextContent(`object:${A}`)
		expect(second).toHaveTextContent(`file:${FILE}`)
		expect(screen.getByText(/Two/).compareDocumentPosition(first)).toBe(
			Node.DOCUMENT_POSITION_PRECEDING,
		)
		expect(second.compareDocumentPosition(screen.getByText('End.'))).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
	})

	it('puts the card of a link in a list item inside that item, after its text', () => {
		renderMessage(`- Check [one](${objectUrl(A)}) today\n- Plain`)
		const [first] = screen.getAllByRole('listitem')
		expect(first.contains(screen.getByTestId('card'))).toBe(true)
		expect(screen.getByRole('link', { name: 'one' })).toBeInTheDocument()
	})

	it('puts the card of a link in a heading after the heading, and keeps the link', () => {
		renderMessage(`## About [it](${objectUrl(A)})\n\nBody.`)
		expect(screen.getByRole('link', { name: 'it' })).toBeInTheDocument()
		expect(screen.getByRole('heading').compareDocumentPosition(screen.getByTestId('card'))).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		)
	})

	it('draws no card for an id an earlier message shows, and its standalone link stays', () => {
		renderMessage(
			`[Email](${objectUrl(A)})\n\nAlso see [this](${objectUrl(A)}) and [b](${objectUrl(B)}).`,
			true,
			new Set([A]),
		)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
		expect(screen.getByTestId('card')).toHaveTextContent(`object:${B}`)
		expect(screen.getByRole('link', { name: 'Email' })).toBeInTheDocument()
	})

	it('tells the card of a revised draft it is updated, in place and under a sentence', () => {
		renderMessage(
			`[Email](${objectUrl(A)})\n\nSee [b](${objectUrl(B)}) for the other one.`,
			true,
			undefined,
			new Set([A, B]),
		)
		const cards = screen.getAllByTestId('card')
		expect(cards).toHaveLength(2)
		for (const card of cards) expect(card).toHaveAttribute('data-updated')
	})

	it('does not tag a card whose id is not in the updated set', () => {
		renderMessage(`[Email](${objectUrl(A)})`, true, undefined, new Set([B]))
		expect(screen.getByTestId('card')).not.toHaveAttribute('data-updated')
	})

	it('draws a draft once, where it stands alone, even when a sentence mentioned it before', () => {
		renderMessage(`I wrote [it](${objectUrl(A)}) for you.\n\n[Email](${objectUrl(A)})`)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
		expect(screen.getByRole('link', { name: 'it' })).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: 'Email' })).not.toBeInTheDocument()
	})

	it('renders exactly as before without the prop', () => {
		const text = `Draft: [Email](${objectUrl(A)})\n\n- [Two](${fileUrl(FILE)})`
		const plain = render(<MarkdownContent content={text} size="sm" />, { wrapper: TestWrapper })
		const before = plain.container.innerHTML
		plain.unmount()
		const withCards = renderMessage(text, false)
		expect(withCards.container.innerHTML).toBe(before)
		expect(screen.queryByTestId('card')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Email' })).toBeInTheDocument()
	})
})
