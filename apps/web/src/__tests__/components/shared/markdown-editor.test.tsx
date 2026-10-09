import { MarkdownEditor, type MarkdownEditorRef } from '@maskin/markdown/react/editor'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

async function mount(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
	const onChange = vi.fn()
	const ref = createRef<MarkdownEditorRef>()
	const utils = render(
		<MarkdownEditor ref={ref} value="# Title\n\nbody" onChange={onChange} {...props} />,
	)
	await waitFor(() => expect(utils.container.querySelector('.ProseMirror')).not.toBeNull())
	const pm = utils.container.querySelector('.ProseMirror') as HTMLElement
	return { ...utils, onChange, ref, pm }
}

describe('MarkdownEditor', () => {
	it('mounts the document variant with headings', async () => {
		const { pm } = await mount({ value: '# Title\n\nsome **bold** text' })
		expect(pm.querySelector('h1')?.textContent).toBe('Title')
		expect(pm.querySelector('strong')?.textContent).toBe('bold')
	})

	it('does not call onChange on blur when nothing was edited', async () => {
		const { pm, onChange } = await mount({ value: 'some _italic_ text\n\n- [ ] todo' })
		fireEvent.focus(pm)
		fireEvent.blur(pm)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('calls onChange once, on blur only, after an edit', async () => {
		const { pm, ref, onChange } = await mount({ value: 'hello' })
		fireEvent.focus(pm)
		act(() => ref.current?.insertContent(' world'))
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.blur(pm)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange.mock.calls[0]?.[0]).toContain('world')

		// A second blur with no further edit stays silent.
		fireEvent.focus(pm)
		fireEvent.blur(pm)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it('falls back to plain text and reports once when markdown parses to an empty doc', async () => {
		const raw = '[//]: # (only a link reference definition)'
		const onParseError = vi.fn()
		const { container } = render(
			<MarkdownEditor
				value={raw}
				onChange={vi.fn()}
				variant="document"
				surface="object-document"
				objectId="obj-1"
				onParseError={onParseError}
			/>,
		)
		await waitFor(() => expect(container.querySelector('pre')).not.toBeNull())
		expect(container.querySelector('pre')?.textContent).toBe(raw)
		expect(container.querySelector('.ProseMirror')).toBeNull()
		expect(onParseError).toHaveBeenCalledTimes(1)
		expect(onParseError).toHaveBeenCalledWith(
			expect.objectContaining({
				variant: 'document',
				surface: 'object-document',
				objectId: 'obj-1',
			}),
		)
	})
})
