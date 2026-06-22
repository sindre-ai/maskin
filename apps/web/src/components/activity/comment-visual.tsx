import { cn } from '@/lib/cn'
import { CommentChart, parseChartSpec } from './comment-chart'

interface CommentVisualProps {
	language: string
	source: string
	className?: string
}

// Inline fallback rendered when a fenced visual block can't be parsed —
// keeps the surrounding markdown intact instead of throwing.
function VisualFallback({ message }: { message: string }) {
	return (
		<div
			data-testid="comment-visual-fallback"
			className="not-prose my-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
		>
			{message}
		</div>
	)
}

// Dispatcher for fenced visual blocks. `language-chart` is the only type wired
// today; mermaid + others slot in here later by adding another branch.
export function CommentVisual({ language, source, className }: CommentVisualProps) {
	if (language === 'chart') {
		let parsed: unknown
		try {
			parsed = JSON.parse(source)
		} catch {
			return <VisualFallback message="Couldn't render chart — invalid JSON" />
		}
		const spec = parseChartSpec(parsed)
		if (!spec) {
			return <VisualFallback message="Couldn't render chart — unsupported chart spec" />
		}
		return <CommentChart spec={spec} className={className} />
	}

	// Unknown language — render the source as a regular code block so nothing is
	// lost. Mirrors the default ReactMarkdown <pre>/<code> output.
	return (
		<pre className={cn('overflow-x-auto max-w-full', className)}>
			<code className={`language-${language}`}>{source}</code>
		</pre>
	)
}

// Visual languages this dispatcher handles. Used by MarkdownContent to decide
// whether to override `pre` with the dispatcher or keep the default <pre>.
export const VISUAL_LANGUAGES = new Set(['chart'])
