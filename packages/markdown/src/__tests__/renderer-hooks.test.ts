import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer, type MarkdownRendererProps } from '../react/renderer'

// A rehype plugin written by hand so the test needs no tree utilities: it tags every <p>.
interface HastLike {
	type: string
	tagName?: string
	properties?: Record<string, unknown>
	children?: HastLike[]
}
function tagParagraphs() {
	return (tree: HastLike) => {
		const walk = (node: HastLike) => {
			if (node.type === 'element' && node.tagName === 'p') {
				node.properties = { ...node.properties, 'data-tagged': 'yes' }
			}
			for (const child of node.children ?? []) walk(child)
		}
		walk(tree)
	}
}

const render = (props: Partial<MarkdownRendererProps>) =>
	renderToStaticMarkup(createElement(MarkdownRenderer, { content: 'hello', ...props }))

describe('MarkdownRenderer extension hooks', () => {
	it('renders exactly as before without the hooks', () => {
		expect(render({})).toContain('<p>hello</p>')
	})

	it('runs extra rehype plugins', () => {
		const html = render({ rehypePlugins: [tagParagraphs] as unknown as never[] })
		expect(html).toContain('<p data-tagged="yes">hello</p>')
	})

	it('merges component overrides over the defaults', () => {
		const html = render({
			getComponentOverrides: () => ({
				p: ({ children }) => createElement('p', { id: 'own' }, children),
			}),
		})
		expect(html).toContain('<p id="own">hello</p>')
	})

	it('hands overrides an identity wrap when there are no mentionActors', () => {
		let wrapped: unknown
		render({
			getComponentOverrides: ({ wrap }) => {
				wrapped = wrap('x')
				return {}
			},
		})
		expect(wrapped).toBe('x')
	})

	it('hands overrides the mention wrap when mentionActors are set', () => {
		let wrapped: unknown
		render({
			mentionActors: [{ id: 'a1', name: 'Ada' }],
			getComponentOverrides: ({ wrap }) => {
				wrapped = wrap('x')
				return {}
			},
		})
		expect(typeof wrapped).toBe('object')
	})
})
