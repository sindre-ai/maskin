// One-line summary for the review panel heading: "2 comments on page 3".
// Counts the open top-level comments (replies belong to a comment, they are not
// counted again). When every open comment sits on the same page the page is
// named; otherwise the line is just the count. Pages are stored zero-based and
// shown one-based.

export interface ReviewSummaryComment {
	parentId: string | null
	resolvedAt: string | null
	page: number | null
}

export function summarizeOpenComments(comments: readonly ReviewSummaryComment[]): string {
	const open = comments.filter((c) => c.parentId === null && !c.resolvedAt)
	if (open.length === 0) return 'Nothing open'
	const noun = open.length === 1 ? 'comment' : 'comments'
	const pages = new Set(open.map((c) => c.page))
	const [only] = [...pages]
	if (pages.size === 1 && only !== null && only !== undefined) {
		return `${open.length} ${noun} on page ${only + 1}`
	}
	return `${open.length} ${noun}`
}
