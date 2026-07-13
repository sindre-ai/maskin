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

const VISUAL_LANGUAGES = new Set(['chart'])

export function isVisualLanguage(language: string | undefined): boolean {
	if (!language) return false
	return VISUAL_LANGUAGES.has(language)
}
