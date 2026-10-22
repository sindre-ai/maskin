import { MarkdownContent } from '@/components/shared/markdown-content'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TestWrapper } from '../../setup'

// Which ids the stand-in resolves to a card. The real component decides this from the fetched
// object or file (covered in linked-object-preview.test.tsx); here only placement is under test.
let qualifying = new Set<string>()
const renderCard = (
	target: { kind: string; id: string },
	fallback: ReactNode,
	context: { label?: string },
) =>
	qualifying.has(target.id) ? (
		<>
			{context.label ? <p>{context.label}</p> : null}
			<div data-testid="card">{`${target.kind}:${target.id}`}</div>
		</>
	) : (
		<>{fallback}</>
	)

const WS = 'ws-1'
const A = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const B = 'b8278eef-4a95-43df-911e-3cb3473a55fb'
const FILE = '5e0c0f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6'
const objectUrl = (id: string) => `https://maskin.io/${WS}/objects/${id}`
const fileUrl = (id: string) => `https://maskin.io/${WS}/files/${id}`

const hasOwnCard = (item: HTMLElement) =>
	Array.from(item.children).some((child) => child.getAttribute('data-testid') === 'card')

function renderMessage(content: string, withCards = true, skipIds?: ReadonlySet<string>) {
	return render(
		<MarkdownContent
			content={content}
			size="sm"
			linkedCards={withCards ? { workspaceId: WS, renderCard, skipIds } : undefined}
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

	it('keeps a standalone link when its object does not qualify, and adds no card', () => {
		qualifying = new Set()
		renderMessage(`[A contact](${objectUrl(A)})`)
		expect(screen.getByRole('link', { name: 'A contact' })).toBeInTheDocument()
		expect(screen.queryByTestId('card')).not.toBeInTheDocument()
	})

	it('keeps a standalone link and its list item while the card is not known yet', () => {
		qualifying = new Set()
		renderMessage(`- [One](${objectUrl(A)})`)
		expect(screen.getByRole('listitem')).toContainElement(screen.getByRole('link', { name: 'One' }))
	})

	it('leaves a link with other text in its paragraph alone, even with a long lead-in', () => {
		qualifying = new Set()
		renderMessage(
			`This is a much longer introduction than any label would be: [x](${objectUrl(A)})`,
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

	it('keeps both links while that id is unresolved, with no card', () => {
		qualifying = new Set()
		renderMessage(`[Email](${objectUrl(A)})\n\nI wrote [it](${objectUrl(A)}) today.`)
		expect(screen.getAllByRole('link')).toHaveLength(2)
		expect(screen.queryByTestId('card')).not.toBeInTheDocument()
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

	it('draws an id once even when a sentence mentions it before a standalone link', () => {
		renderMessage(`I wrote [it](${objectUrl(A)}) for you.\n\n[Email](${objectUrl(A)})`)
		expect(screen.getAllByTestId('card')).toHaveLength(1)
		expect(screen.getByRole('link', { name: 'Email' })).toBeInTheDocument()
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
