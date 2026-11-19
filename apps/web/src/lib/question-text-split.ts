/** A question's text (a whole draft, say) shows this many lines; the rest opens with Show all. Same as iPhone. */
export const QUESTION_DETAIL_LINES = 6

const MIN_DETAIL_AFTER_QUESTION = 40
const LONG_TEXT_LENGTH = 140

export interface QuestionTextSplit {
	/** The question itself, shown as the headline and never cut. */
	lead: string
	/** The text the question carries, below it; null when there is none. */
	detail: string | null
}

const length = (text: string) => Array.from(text).length

/**
 * The index just after the first of `marks` (a regex character class body) that ends a sentence:
 * followed by whitespace or the end of the text, so a "?" inside a link does not count.
 */
function sentenceEnd(text: string, marks: string): number | null {
	const match = new RegExp(`[${marks}](?=\\s|$)`).exec(text)
	return match ? match.index + match[0].length : null
}

/**
 * A question's single text field, split into the question itself and the text it carries, so the
 * card can show the question and the options together and cut the rest. The server sends one
 * field, so the split is a client rule, and it is the same rule as iPhone (QuestionTextSplit in
 * apps/apple/Sources/MaskinCore/Chats):
 * 1. A "?" that ends a sentence with at least 40 characters after it: the lead runs up to and
 *    including it.
 * 2. Else, a text over 140 characters with a sentence end: the lead is the first sentence.
 * 3. Else no split: the whole text is the lead.
 */
export function splitQuestionText(input: string): QuestionTextSplit {
	const text = input.trim()
	const questionEnd = sentenceEnd(text, '\\?')
	if (questionEnd !== null) {
		const rest = text.slice(questionEnd).trim()
		if (length(rest) >= MIN_DETAIL_AFTER_QUESTION) {
			return { lead: text.slice(0, questionEnd), detail: rest }
		}
	}
	if (length(text) > LONG_TEXT_LENGTH) {
		const end = sentenceEnd(text, '.!?')
		if (end !== null) {
			const rest = text.slice(end).trim()
			if (rest) return { lead: text.slice(0, end), detail: rest }
		}
	}
	return { lead: text, detail: null }
}
