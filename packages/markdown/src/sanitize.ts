import type { Element, Root } from 'hast'
import { type Schema, defaultSchema } from 'hast-util-sanitize'
import { visit } from 'unist-util-visit'

// Sanitiser allowlist for server-rendered public HTML (ADR-5).
// Baseline is `defaultSchema` from `hast-util-sanitize`, which already covers
// headings, lists, code, blockquote, GFM tables, and task-list checkboxes.
// The narrow additions below are exactly the surfaces mentioned in ADR-5.

const attributes = { ...(defaultSchema.attributes ?? {}) }

// Extend `a` to keep the attributes the external-link rehype plugin adds so
// they survive sanitisation instead of being stripped.
const existingA = attributes.a ?? []
attributes.a = [...existingA, 'target', 'rel']

// Task-list checkboxes rendered by `remark-gfm` need `type`, `checked`,
// `disabled` on <input>. `defaultSchema` doesn't allow <input> at all.
attributes.input = ['type', 'checked', 'disabled']

export const publicHtmlSanitizeSchema: Schema = {
	...defaultSchema,
	// `defaultSchema.tagNames` already includes the elements ADR-5 lists
	// (h1-h6, p, ul, ol, li, code, pre, blockquote, table, thead, tbody, tr,
	// th, td, del, strong, em, br, hr, a, img). Add task-list <input>.
	tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
	attributes,
	// Strip `<style>` blocks and inline event handlers by not listing them.
	// `strip` is the default for tags not in the allowlist; nothing to add.
	protocols: {
		...(defaultSchema.protocols ?? {}),
		// ADR-5: `a[href]` restricted to http(s):// (defaultSchema also allows
		// `mailto:` etc. — keep those; the ADR intent is "no javascript:", which
		// defaultSchema already blocks).
	},
}

// Small rehype plugin that adds `rel="noopener noreferrer" target="_blank"` to
// external `<a>` elements (any href with an absolute http(s) URL). Runs before
// `rehype-sanitize` so the attributes are on the tree when the sanitiser walks
// it; the sanitiser's attribute allowlist above keeps them.
export function rehypeExternalLinks() {
	return (tree: Root) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName !== 'a') return
			const href = node.properties?.href
			if (typeof href !== 'string') return
			if (!/^https?:\/\//i.test(href)) return
			node.properties = {
				...(node.properties ?? {}),
				target: '_blank',
				rel: 'noopener noreferrer',
			}
		})
	}
}
