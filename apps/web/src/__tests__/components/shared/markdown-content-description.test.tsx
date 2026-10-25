import { MarkdownContent, READ_ONLY_DESCRIPTION_BANNER } from '@/components/shared/markdown-content'
import { capture } from '@/lib/posthog'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }))

const FLAG = 'ff:rich-markdown-editor'

function parseErrorCalls() {
	return vi
		.mocked(capture)
		.mock.calls.filter(([name]) => name === 'editor_markdown_parse_error')
		.map(([, props]) => props)
}

function mount(content: string, onChange = vi.fn()) {
	const utils = render(
		<MarkdownContent
			content={content}
			onChange={onChange}
			editable
			preserveSource
			surface="description"
			objectId="obj-1"
		/>,
	)
	return { ...utils, onChange }
}

describe('MarkdownContent description with preserveSource', () => {
	beforeEach(() => {
		vi.mocked(capture).mockClear()
		localStorage.setItem(FLAG, 'on')
	})
	afterEach(() => {
		localStorage.removeItem(FLAG)
	})

	it('opens a plain agent description in the editor with no banner', async () => {
		const { container } = mount('# Title\n\nA paragraph.\n\n- one\n- two\n')
		await waitFor(() =>
			expect(container.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull(),
		)
		expect(screen.queryByText(READ_ONLY_DESCRIPTION_BANNER)).toBeNull()
		expect(parseErrorCalls()).toHaveLength(0)
	})

	it.each([
		['front matter', '---\ntitle: Spec\n---\n\nBody.\n', 'front_matter'],
		[
			'raw HTML',
			'Intro.\n\n<details>\n<summary>More</summary>\n\nhidden\n\n</details>\n',
			'raw_html',
		],
		['an HTML comment', 'Intro.\n\n<!-- agent note -->\n\nOutro.\n', 'raw_html'],
		['a footnote', 'A claim.[^1]\n\n[^1]: The source.\n', 'footnote'],
		[
			'a link reference definition',
			'See [docs][ref].\n\n[ref]: https://example.com\n',
			'link_reference',
		],
	])('opens read-only with the banner and one event for %s', async (_label, text, cause) => {
		const { container, onChange } = mount(text)
		await screen.findByText(READ_ONLY_DESCRIPTION_BANNER)
		await waitFor(() => expect(parseErrorCalls()).toHaveLength(1))
		expect(parseErrorCalls()[0]).toMatchObject({
			reason: 'read_only_fallback',
			surface: 'description',
			object_id: 'obj-1',
			cause,
		})
		expect(container.querySelector('.ProseMirror[contenteditable="true"]')).toBeNull()
		expect(onChange).not.toHaveBeenCalled()
	})

	it('shows no banner for angle-bracket placeholder words', async () => {
		const { container } = mount('Assign <owner> to <id> before Friday.\n')
		await waitFor(() =>
			expect(container.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull(),
		)
		expect(screen.queryByText(READ_ONLY_DESCRIPTION_BANNER)).toBeNull()
	})
})
