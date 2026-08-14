import { CommentChart, CommentChartFallback, parseChartSpec } from './comment-chart'

interface CommentVisualProps {
	language: string
	source: string
}

export function CommentVisual({ language, source }: CommentVisualProps) {
	if (language === 'chart') {
		const result = parseChartSpec(source)
		if (!result.ok) return <CommentChartFallback reason={result.reason} />
		return <CommentChart spec={result.spec} />
	}
	return <CommentChartFallback reason={`unsupported visual "${language}"`} />
}

export { isVisualLanguage } from './comment-visual-language'

export default CommentVisual
