// A new placeholder must never rebuild the editor: the new-chat box changes its hint when the
// first recipient is picked, and the text typed before that has to stay.

import type { Editor } from '@tiptap/core'
import { createElement } from 'react'
import { act } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownEditor, type MarkdownEditorRef } from '../react/editor'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
	act(() => root?.unmount())
	host?.remove()
	root = null
	host = null
})

function render(placeholder: string, ref: { current: MarkdownEditorRef | null }) {
	return createElement(MarkdownEditor, {
		ref,
		value: '',
		onChange: () => {},
		variant: 'notification',
		placeholder,
	})
}

const hint = () => host?.querySelector('p.is-editor-empty')?.getAttribute('data-placeholder')

describe('MarkdownEditor placeholder', () => {
	it('keeps the typed text and the same editor when the placeholder changes', async () => {
		host = document.createElement('div')
		document.body.appendChild(host)
		root = createRoot(host)
		const ref: { current: MarkdownEditorRef | null } = { current: null }

		await act(async () => root?.render(render('Pick an agent, then write your first message', ref)))
		const view = host.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null
		expect(view).not.toBeNull()
		expect(hint()).toBe('Pick an agent, then write your first message')

		await act(async () => ref.current?.insertContent('hello there'))
		expect(ref.current?.getMarkdown()).toBe('hello there')

		await act(async () => root?.render(render('Write your first message', ref)))
		expect(ref.current?.getMarkdown()).toBe('hello there')
		// The same editor element: it was not torn down and rebuilt.
		expect(host.querySelector('.ProseMirror')).toBe(view)
		expect(view?.textContent).toContain('hello there')
	})

	it('shows the new hint in an empty box', async () => {
		host = document.createElement('div')
		document.body.appendChild(host)
		root = createRoot(host)
		const ref: { current: MarkdownEditorRef | null } = { current: null }

		await act(async () => root?.render(render('Pick an agent, then write your first message', ref)))
		const view = host.querySelector('.ProseMirror')
		await act(async () => root?.render(render('Write your first message', ref)))

		expect(hint()).toBe('Write your first message')
		expect(host.querySelector('.ProseMirror')).toBe(view)
	})
})
