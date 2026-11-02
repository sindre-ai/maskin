import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useLoop = vi.fn()
const useTrigger = vi.fn()
const useObject = vi.fn()
let workspaces: Array<{ id: string; name: string }> | undefined

vi.mock('@/hooks/use-loops', () => ({ useLoop: (...args: unknown[]) => useLoop(...args) }))
vi.mock('@/hooks/use-triggers', () => ({ useTrigger: (...args: unknown[]) => useTrigger(...args) }))
vi.mock('@/hooks/use-objects', () => ({ useObject: (...args: unknown[]) => useObject(...args) }))
vi.mock('@/hooks/use-workspaces', () => ({ useWorkspaces: () => ({ data: workspaces }) }))
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		to,
		params,
		...rest
	}: {
		children: React.ReactNode
		className?: string
		to: string
		params: Record<string, string>
	} & Record<string, unknown>) => (
		<a
			href={to.replace(/\$(\w+)/g, (_, key: string) => params[key])}
			className={className}
			aria-label={rest['aria-label'] as string | undefined}
			target={rest.target as string | undefined}
			rel={rest.rel as string | undefined}
			data-linked-card={rest['data-linked-card'] as string | undefined}
		>
			{children}
		</a>
	),
}))

import { renderLinkedCard, renderLinkedChip } from '@/components/chat/linked-object-preview'
import { OtherWorkspaceCard, OtherWorkspaceChip } from '@/components/chat/linked-object-reference'

const HERE = 'e2877e32-2c11-489e-96c8-a76200908ed4'
const THERE = '11111111-2222-4333-8444-555555555555'
const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'

beforeEach(() => {
	useLoop.mockReset()
	useTrigger.mockReset()
	useObject.mockReset()
	workspaces = [
		{ id: HERE, name: 'Maskin' },
		{ id: THERE, name: 'Acme Labs' },
	]
})

describe('OtherWorkspaceChip', () => {
	it('names the kind and the workspace you belong to, and opens it', () => {
		render(<OtherWorkspaceChip kind="loop" otherWorkspaceId={THERE} id={ID} />)
		const link = screen.getByRole('link', { name: 'Loop in Acme Labs' })
		expect(link).toHaveAttribute('href', `/${THERE}/loops/${ID}`)
		expect(link).toHaveTextContent('Loop in Acme Labs')
		expect(link.className).toContain('border-dashed')
		expect(link.className).toContain('italic')
		expect(link.querySelector('svg.lucide-globe')).not.toBeNull()
	})

	it('says "another workspace" when you do not belong to it, or the list is not in yet', () => {
		workspaces = [{ id: HERE, name: 'Maskin' }]
		const { unmount } = render(
			<OtherWorkspaceChip kind="trigger" otherWorkspaceId={THERE} id={ID} />,
		)
		expect(screen.getByRole('link', { name: 'Trigger in another workspace' })).toBeInTheDocument()
		unmount()
		workspaces = undefined
		render(<OtherWorkspaceChip kind="object" otherWorkspaceId={THERE} id={ID} />)
		expect(screen.getByRole('link', { name: 'Object in another workspace' })).toHaveAttribute(
			'href',
			`/${THERE}/objects/${ID}`,
		)
	})

	it('has no preview and opens in the same tab', () => {
		render(<OtherWorkspaceChip kind="object" otherWorkspaceId={THERE} id={ID} />)
		const link = screen.getByRole('link')
		expect(link).not.toHaveAttribute('target')
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
})

describe('OtherWorkspaceCard', () => {
	it('is one dashed, italic link with a globe, counted as a card', () => {
		render(<OtherWorkspaceCard kind="object" otherWorkspaceId={THERE} id={ID} />)
		const link = screen.getByRole('link', { name: 'Object in Acme Labs' })
		expect(link).toHaveAttribute('href', `/${THERE}/objects/${ID}`)
		expect(link).toHaveAttribute('data-linked-card')
		expect(link.className).toContain('border-dashed')
		expect(link.className).toContain('italic')
		expect(link.querySelector('svg.lucide-globe')).not.toBeNull()
		expect(link).toHaveTextContent('Object in Acme Labs')
	})

	it('says "another workspace" when you do not belong to it', () => {
		workspaces = [{ id: HERE, name: 'Maskin' }]
		render(<OtherWorkspaceCard kind="loop" otherWorkspaceId={THERE} id={ID} />)
		expect(screen.getByRole('link', { name: 'Loop in another workspace' })).toBeInTheDocument()
	})
})

describe('renderLinkedCard and renderLinkedChip', () => {
	const other = (kind: 'object' | 'loop' | 'trigger' | 'agent' | 'chat') => ({
		kind,
		id: ID,
		workspaceId: THERE,
	})

	it('draw the placeholder for each kind and fetch nothing for it', () => {
		for (const kind of ['object', 'loop', 'trigger', 'agent', 'chat'] as const) {
			const { unmount } = render(renderLinkedCard(other(kind), null, { workspaceId: HERE }))
			expect(screen.getByRole('link')).toHaveAttribute('data-linked-card')
			unmount()
			const chip = render(renderLinkedChip(other(kind), null, { workspaceId: HERE }))
			expect(screen.getByRole('link').className).toContain('border-dashed')
			chip.unmount()
		}
		expect(useObject).not.toHaveBeenCalled()
		expect(useLoop).not.toHaveBeenCalled()
		expect(useTrigger).not.toHaveBeenCalled()
	})

	it('draw nothing under a sentence, and keep the chip in a list', () => {
		const { container } = render(
			renderLinkedCard(other('object'), null, { workspaceId: HERE, after: true }),
		)
		expect(container).toBeEmptyDOMElement()
		render(
			renderLinkedCard(other('loop'), <span>the chip</span>, {
				workspaceId: HERE,
				inList: true,
			}),
		)
		expect(screen.getByText('the chip')).toBeInTheDocument()
	})

	it('no longer read "Deleted object" for a link into another workspace', () => {
		render(renderLinkedChip(other('object'), null, { workspaceId: HERE }))
		expect(screen.queryByText(/Deleted/)).not.toBeInTheDocument()
	})
})
