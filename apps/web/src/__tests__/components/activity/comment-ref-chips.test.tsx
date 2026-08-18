import { CommentRefChips, extractRefs, hasRefs } from '@/components/activity/comment-ref-chips'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildEventResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

// <Link> needs a router; these tests only care that a chip is or isn't a link
// and what it points at, so record `to`/`params` on a plain element instead.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		to,
		params,
	}: {
		children: React.ReactNode
		className?: string
		to: string
		params?: Record<string, string>
	}) => (
		<span className={className} data-to={to} data-params={JSON.stringify(params ?? {})}>
			{children as React.ReactNode}
		</span>
	),
}))

const OBJECT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'

function eventWithRefs(refs: unknown[]) {
	return buildEventResponse({ action: 'commented', data: { content: 'here', refs } })
}

describe('hasRefs', () => {
	it('returns false for non-commented events', () => {
		expect(hasRefs(buildEventResponse({ action: 'created', data: { refs: [] } }))).toBe(false)
	})

	it('returns false when there are no refs', () => {
		expect(hasRefs(buildEventResponse({ action: 'commented', data: { content: 'hi' } }))).toBe(
			false,
		)
	})

	it('returns true for a well-formed ref', () => {
		expect(
			hasRefs(eventWithRefs([{ kind: 'page', tag: 'PAGE', label: 'Loops', path: 'loops' }])),
		).toBe(true)
	})
})

describe('extractRefs', () => {
	it('drops an object ref without a valid uuid', () => {
		const refs = extractRefs(
			eventWithRefs([{ kind: 'object', tag: 'BET', label: 'A bet', object_id: 'not-a-uuid' }]),
		)
		expect(refs).toEqual([])
	})

	it('drops a page ref whose path could escape the workspace', () => {
		const refs = extractRefs(
			eventWithRefs([{ kind: 'page', tag: 'PAGE', label: 'Evil', path: '../../etc' }]),
		)
		expect(refs).toEqual([])
	})

	it('drops refs of an unknown kind', () => {
		const refs = extractRefs(eventWithRefs([{ kind: 'webhook', tag: 'X', label: 'nope' }]))
		expect(refs).toEqual([])
	})

	it('caps the list so one comment cannot render an unbounded wall of chips', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({
			kind: 'page',
			tag: 'PAGE',
			label: `Page ${i}`,
			path: 'loops',
		}))
		expect(extractRefs(eventWithRefs(many))).toHaveLength(6)
	})
})

describe('CommentRefChips', () => {
	it('renders an object ref as a link to that object', () => {
		render(
			<TestWrapper>
				<CommentRefChips
					event={eventWithRefs([
						{ kind: 'object', tag: 'KNOWLEDGE', label: 'What Acme does', object_id: OBJECT_ID },
					])}
				/>
			</TestWrapper>,
		)
		const chip = screen.getByText('What Acme does').closest('[data-to]')
		expect(chip).toHaveAttribute('data-to', '/$workspaceId/objects/$objectId')
		expect(chip?.getAttribute('data-params')).toContain(OBJECT_ID)
		expect(screen.getByText('KNOWLEDGE')).toBeInTheDocument()
	})

	it('maps a marketplace loop path onto the typed loop route', () => {
		render(
			<TestWrapper>
				<CommentRefChips
					event={eventWithRefs([
						{ kind: 'page', tag: 'LOOP', label: 'Build & Ship', path: `marketplace/${OBJECT_ID}` },
					])}
				/>
			</TestWrapper>,
		)
		const chip = screen.getByText('Build & Ship').closest('[data-to]')
		expect(chip).toHaveAttribute('data-to', '/$workspaceId/marketplace/$loopId')
		expect(chip?.getAttribute('data-params')).toContain(OBJECT_ID)
	})

	it('renders an unroutable page ref as plain text rather than guessing a destination', () => {
		render(
			<TestWrapper>
				<CommentRefChips
					event={eventWithRefs([
						{ kind: 'page', tag: 'PAGE', label: 'Nowhere', path: 'not-a-real-page' },
					])}
				/>
			</TestWrapper>,
		)
		expect(screen.getByText('Nowhere')).toBeInTheDocument()
		expect(screen.getByText('Nowhere').closest('[data-to]')).toBeNull()
	})

	it('keeps a ref with a detail collapsed until it is expanded', async () => {
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<CommentRefChips
					event={eventWithRefs([
						{
							kind: 'page',
							tag: 'PAGE',
							label: 'Loops',
							path: 'loops',
							detail: 'Work that runs without anyone starting it.',
						},
					])}
				/>
			</TestWrapper>,
		)

		expect(screen.queryByText(/Work that runs without anyone/)).not.toBeInTheDocument()

		const toggle = screen.getByRole('button', { name: /Loops/ })
		expect(toggle).toHaveAttribute('aria-expanded', 'false')
		await user.click(toggle)

		expect(screen.getByText(/Work that runs without anyone/)).toBeInTheDocument()
		expect(toggle).toHaveAttribute('aria-expanded', 'true')
		// The explainer carries the way out to the real page.
		expect(screen.getByText(/Open Loops/).closest('[data-to]')).toHaveAttribute(
			'data-to',
			'/$workspaceId/loops',
		)
	})
})
