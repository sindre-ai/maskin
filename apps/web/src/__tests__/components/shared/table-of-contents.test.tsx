import { TableOfContents } from '@/components/shared/table-of-contents'
import { render, screen } from '@testing-library/react'
import { type RefObject, useRef } from 'react'
import { describe, expect, it } from 'vitest'

function Harness({ html, content }: { html: string; content: string }) {
	const ref = useRef<HTMLDivElement>(null)
	return (
		<div>
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: test-only rendering */}
			<div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
			<TableOfContents targetRef={ref as RefObject<HTMLElement | null>} content={content} />
		</div>
	)
}

describe('TableOfContents', () => {
	it('renders nothing when there are fewer than two headings with ids', () => {
		const { container } = render(
			<Harness html={'<h2 id="only">Only section</h2>'} content={'## Only section'} />,
		)
		expect(container.querySelector('nav')).toBeNull()
	})

	it('renders one anchor per h2/h3 heading when there are multiple', () => {
		const html = [
			'<h2 id="first">First</h2>',
			'<h3 id="first-sub">First sub</h3>',
			'<h2 id="second">Second</h2>',
		].join('')
		render(<Harness html={html} content={'## First\n### First sub\n## Second'} />)
		expect(screen.getByRole('navigation', { name: 'Table of contents' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'First' })).toHaveAttribute('href', '#first')
		expect(screen.getByRole('link', { name: 'First sub' })).toHaveAttribute('href', '#first-sub')
		expect(screen.getByRole('link', { name: 'Second' })).toHaveAttribute('href', '#second')
	})

	it('skips headings that lack an id attribute', () => {
		const html = ['<h2>No id</h2>', '<h2 id="with-id">Has id</h2>'].join('')
		render(<Harness html={html} content={'## No id\n## Has id'} />)
		// Only the ones with ids show up; that's 1 → nav should not render
		expect(screen.queryByRole('navigation', { name: 'Table of contents' })).toBeNull()
	})
})
