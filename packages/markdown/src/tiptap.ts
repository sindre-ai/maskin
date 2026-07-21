import rehypeParse from 'rehype-parse'
import rehypeRemark from 'rehype-remark'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remarkStringify from 'remark-stringify'
import { unified } from 'unified'
import { canonicalStringifyOptions } from './serialize'

// Editor IO layer for the object-body TipTap mount. Load goes markdown →
// hast → HTML, the shape TipTap consumes via `editor.commands.setContent`.
// Save goes TipTap HTML → hast → mdast → canonical Markdown via the same
// stringify options the T1 round-trip corpus asserts on. Every write leaves
// the pipeline through `canonicalStringifyOptions` so no drift can slip in
// through a divergent second serializer.
//
// `remark-breaks` is deliberately omitted from the load direction: TipTap
// converts single newlines back to soft breaks at render time. Promoting
// them to hard breaks on load would inject a `<br>` for every soft break
// and the writer would send `\\\n` back, which is not what the source said.

const mdToHtmlProcessor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype)
	.use(rehypeStringify)

// markdown → editor HTML. No sanitize step here because the editor is a
// first-party surface; the public renderer keeps its own sanitize pipeline.
export function markdownToEditorHtml(markdown: string): string {
	return String(mdToHtmlProcessor.processSync(markdown))
}

const htmlToMdProcessor = unified()
	.use(rehypeParse, { fragment: true })
	.use(rehypeRemark)
	.use(remarkGfm)
	.use(remarkStringify, canonicalStringifyOptions)

// Editor HTML (from `editor.getHTML()` or a paste event) → canonical
// Markdown via the owned serializer options. Used on autosave and on paste
// so raw HTML never enters storage and never leaves via serialize.
export function editorHtmlToMarkdown(html: string): string {
	return String(htmlToMdProcessor.processSync(html)).replace(/\n+$/, '\n')
}
