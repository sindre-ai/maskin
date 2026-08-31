import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// tiptap-markdown round-trips through a Tiptap `Editor` instance, which
		// creates a ProseMirror EditorState that touches `document` at
		// construction time. jsdom supplies the DOM globals — happy-dom is
		// smaller but has surfaced ProseMirror compat issues in the past.
		environment: 'jsdom',
		include: ['src/__tests__/**/*.test.ts'],
	},
})
