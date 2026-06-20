import { MarkdownContent } from '@/components/shared/markdown-content'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', () => ({
	api: {
		objects: {
			get: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

describe('MarkdownContent', () => {
	it('renders markdown content', () => {
		render(<MarkdownContent content="**bold text**" />)
		expect(screen.getByText('bold text')).toBeInTheDocument()
	})

	it('shows placeholder when editable and content is empty', () => {
		render(<MarkdownContent content="" editable />)
		expect(screen.getByPlaceholderText('Click to add content...')).toBeInTheDocument()
	})

	it('enters edit mode on click when editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="some text" editable onChange={vi.fn()} />)

		await user.click(screen.getByText('some text'))
		expect(screen.getByRole('textbox')).toBeInTheDocument()
	})

	it('calls onChange on blur with modified content', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		const textarea = screen.getByRole('textbox')
		await user.clear(textarea)
		await user.type(textarea, 'updated')
		await user.tab()

		expect(onChange).toHaveBeenCalledWith('updated')
	})

	it('does not call onChange when content unchanged', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MarkdownContent content="original" editable onChange={onChange} />)

		await user.click(screen.getByText('original'))
		await user.tab()

		expect(onChange).not.toHaveBeenCalled()
	})

	it('does not enter edit mode when not editable', async () => {
		const user = userEvent.setup()
		render(<MarkdownContent content="read only" />)

		await user.click(screen.getByText('read only'))
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
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

	describe('linkifyObjectIds', () => {
		beforeEach(() => {
			vi.mocked(api.objects.get).mockReset()
		})

		it('renders a bare object UUID as an inline ObjectReference chip', () => {
			const obj = buildObjectResponse({
				id: 'cf6545dc-74dd-4cba-ab27-16d808112bee',
				title: 'Inline Bet',
				type: 'bet',
				status: 'active',
			})
			vi.mocked(api.objects.get).mockResolvedValue(obj)

			render(
				<MarkdownContent
					content={`See ${obj.id} for context`}
					linkifyObjectIds
					workspaceId="ws-1"
				/>,
				{ wrapper: TestWrapper },
			)

			// The chip starts in its loading skeleton state before useObject resolves.
			expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument()
			// Surrounding text still renders as plain text.
			expect(screen.getByText(/See/)).toBeInTheDocument()
			expect(screen.getByText(/for context/)).toBeInTheDocument()
			// The raw UUID does NOT appear as visible text — the chip swaps it out.
			expect(screen.queryByText(obj.id)).not.toBeInTheDocument()
		})

		it('leaves text alone when no UUID is present', () => {
			render(
				<MarkdownContent
					content="No object id here, just words."
					linkifyObjectIds
					workspaceId="ws-1"
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByText('No object id here, just words.')).toBeInTheDocument()
			expect(api.objects.get).not.toHaveBeenCalled()
		})

		it('no-ops when workspaceId is missing even if the flag is set', () => {
			const uuid = 'cf6545dc-74dd-4cba-ab27-16d808112bee'
			render(<MarkdownContent content={`See ${uuid} here`} linkifyObjectIds />, {
				wrapper: TestWrapper,
			})
			// Without a workspace id we can't build a deep-link, so the UUID stays
			// inline as plain text and no fetch fires.
			expect(screen.getByText(/See/)).toBeInTheDocument()
			expect(api.objects.get).not.toHaveBeenCalled()
		})
	})
})
