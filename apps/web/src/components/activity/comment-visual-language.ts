const VISUAL_LANGUAGES = new Set(['chart'])

export function isVisualLanguage(language: string | undefined): boolean {
	if (!language) return false
	return VISUAL_LANGUAGES.has(language)
}
