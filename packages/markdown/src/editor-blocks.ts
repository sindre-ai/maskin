// The Tiptap side of the touched-blocks save: read the editor's top-level
// blocks as markdown text and as comparable features. The splice itself is in
// `./source-blocks.ts`.

import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
	type BlockFeatures,
	type MarkdownItLike,
	emptyFeatures,
	normalizeText,
} from './source-blocks'

/** The markdown-it instance tiptap-markdown parses with, so block boundaries match the editor. */
export function editorMarkdownIt(editor: Editor): MarkdownItLike {
	return (editor.storage.markdown.parser as { md: MarkdownItLike }).md
}

/** The editor's markdown for each top-level block of its document, one string per block. */
export function serializeTopLevelBlocks(editor: Editor): string[] {
	const blocks: string[] = []
	const { doc } = editor.state
	for (let index = 0; index < doc.childCount; index++) {
		const single = editor.schema.topNodeType.create(null, [doc.child(index)])
		const markdown = editor.storage.markdown.serializer.serialize(single) as string
		blocks.push(markdown.replace(/\n+$/, ''))
	}
	return blocks
}

/** What a top-level editor block says, in the same terms as `blockFeatures`. */
export function nodeFeatures(node: ProseMirrorNode): BlockFeatures {
	const features = emptyFeatures()
	let text = ''
	const visit = (current: ProseMirrorNode) => {
		const name = current.type.name
		if (name === 'heading') features.headingLevels.push(Number(current.attrs.level))
		if (name === 'codeBlock') {
			const language = typeof current.attrs.language === 'string' ? current.attrs.language : ''
			features.code.push(`${language}\u0000${current.textContent}`)
		}
		if (name === 'taskItem') features.tasks.push(current.attrs.checked ? 'x' : ' ')
		if (name === 'image') {
			const { src, alt, title } = current.attrs
			features.images.push(`${src ?? ''}\u0000${alt ?? ''}\u0000${title ?? ''}`)
		}
		if (name === 'hardBreak') text += ' '

		if (current.isTextblock) {
			let linkHref: string | null = null
			for (let index = 0; index < current.childCount; index++) {
				const child = current.child(index)
				const href = child.marks.find((mark) => mark.type.name === 'link')?.attrs.href ?? null
				if (href !== null && href !== linkHref) {
					features.linkTargets.push(String(href))
					// The editor has no link title, so a link it writes has none.
					features.linkTitles.push('')
				}
				linkHref = href
			}
		}
		if (current.isText) text += current.text ?? ''
		current.forEach(visit)
	}
	visit(node)
	features.text = normalizeText(text)
	return features
}
