import type { TextCommentHighlight } from '@maskin/markdown/react/editor'
import type { TextAnchor } from '@maskin/shared'
import { type ReactNode, createContext, useContext } from 'react'

// Carries comments on selected text between the file route (which owns the
// comment list, drafts and the review panel) and the markdown file editor
// (which draws the highlights and offers the Comment action). Only the file
// route provides it; any other place the editor mounts gets null and shows no
// Comment action.

/** Asks the panel to bring a comment's highlight into view. */
export interface TextCommentScrollRequest {
	id: string
	/** Also move the caret to the highlight (the card's quote button). */
	focus: boolean
	/** Bumps on every request so asking for the same comment twice still fires. */
	nonce: number
}

export interface TextCommentsContextValue {
	/** Saved comments and unsent drafts that carry a text anchor. */
	highlights: TextCommentHighlight[]
	/** The comment whose card is open. */
	activeId: string | null
	/** Save draft in the compose box: add a draft with this anchor and text. */
	onCompose: (input: {
		anchor: TextAnchor
		position: { x: number; y: number }
		body: string
	}) => void
	/** A highlight was clicked: open and mark its card. A click elsewhere in the text (null) clears it. */
	onHighlightClick: (id: string | null) => void
	/** The comments whose quote no longer matches the text. */
	onOrphansChange: (orphanedIds: string[]) => void
	/** Set when a card asks for its highlight; the editor scrolls to it. */
	scrollRequest: TextCommentScrollRequest | null
}

const TextCommentsContext = createContext<TextCommentsContextValue | null>(null)

export function TextCommentsProvider({
	value,
	children,
}: {
	value: TextCommentsContextValue
	children: ReactNode
}) {
	return <TextCommentsContext.Provider value={value}>{children}</TextCommentsContext.Provider>
}

export function useTextComments(): TextCommentsContextValue | null {
	return useContext(TextCommentsContext)
}

/** Element id of a panel card, the target of its highlight's aria-describedby. */
export function textCommentCardId(id: string): string {
	return `file-comment-card-${id}`
}
