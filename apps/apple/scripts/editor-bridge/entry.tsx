// Bridge between the Swift host and the shared markdown editor. Swift calls window.maskinEditor.open(...),
// setAppearance(...) and getMarkdown(); this page reports back through the "editor" message handler.
// Only the shared markdown package and Tiptap are in here: no web app code, no network, no keys.
import { MarkdownEditor, type MarkdownEditorRef } from '@maskin/markdown/react/editor'
import { createRef } from 'react'
import { createRoot } from 'react-dom/client'

interface EditorHost {
	maskinEditor: {
		open(markdown: string, placeholder: string): void
		setAppearance(dark: boolean, fontScale: number): void
		getMarkdown(): string
		focus(): void
	}
	webkit?: { messageHandlers: { editor: { postMessage(message: unknown): void } } }
}
const host = window as unknown as EditorHost

const editorRef = createRef<MarkdownEditorRef>()
const container = document.getElementById('editor') as HTMLElement
const root = createRoot(container)
// The text as it was opened. getMarkdown hands this back until the editor is ready, so a Save that
// races the page can never write anything but the original.
let opened = ''
let readOnly = false
let generation = 0

function post(event: string, detail?: unknown) {
	try {
		host.webkit?.messageHandlers.editor.postMessage({ event, detail: detail ?? null })
	} catch (_) {}
}

function render(markdown: string, placeholder: string) {
	generation += 1
	root.render(
		<MarkdownEditor
			key={generation}
			ref={editorRef}
			value={markdown}
			onChange={() => {}}
			variant="document"
			preserveSource
			placeholder={placeholder}
			ariaLabel="Description"
			surface="iphone"
			onParseError={(info) => {
				if (info.reason === 'read_only_fallback') {
					readOnly = true
					post('readOnly', { cause: info.cause ?? null })
				}
			}}
		/>,
	)
}
host.maskinEditor = {
	// The description and the placeholder come from Swift and are never logged here.
	open(markdown: string, placeholder: string) {
		opened = markdown
		readOnly = false
		render(markdown, placeholder)
		// The read-only check runs just after mount. Give it a moment, so a text the editor cannot
		// hold is reported before the app shows the page.
		setTimeout(() => {
			if (!readOnly) post('opened')
		}, 150)
	},
	setAppearance(dark: boolean, fontScale: number) {
		document.documentElement.classList.toggle('dark', dark)
		document.documentElement.style.fontSize = `${16 * fontScale}px`
	},
	// The text to save. A description the editor holds read-only is returned as it was opened.
	getMarkdown(): string {
		if (readOnly) return opened
		return editorRef.current ? editorRef.current.getMarkdown() : opened
	},
	focus() {
		editorRef.current?.focus()
	},
}

post('ready')
