import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { remarkPlugins } from './plugins'
import { publicHtmlSanitizeSchema, rehypeExternalLinks } from './sanitize'

// Server-side markdown → sanitised HTML pipeline for the public method site
// (ADR-1 + ADR-5). Raw HTML is never passed through: `remarkRehype` is called
// without `allowDangerousHtml`, and `rehypeSanitize` runs with the narrow
// allowlist in `sanitize.ts`.
const processor = unified()
	.use(remarkParse)
	.use(remarkPlugins as unknown as never[])
	.use(remarkRehype)
	.use(rehypeExternalLinks)
	.use(rehypeSanitize, publicHtmlSanitizeSchema)
	.use(rehypeStringify)

export function renderMarkdownToHtml(markdown: string): string {
	const file = processor.processSync(markdown)
	return String(file)
}
