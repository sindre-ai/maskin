import { useNewDesign } from '@/lib/new-design-context'
import { CommentInput as CommentInputV2 } from './comment-input.v2'
import { CommentInput as LegacyCommentInput } from './legacy/comment-input'

/**
 * The `new-design` boundary for the comment composer.
 *
 * The composer is rendered by the object activity feed and the For You cards —
 * route-page surfaces, not the shell — so like the create overlay it takes the
 * flag from `NewDesignProvider` rather than from a second `useFeatureFlag`
 * call.
 *
 * v2 adds the dictation control, "Reference an object" and "Attach a decision";
 * the pre-v2 composer has none of them. v2's props are a superset of the
 * legacy ones, so no call site changes.
 */
export function CommentInput(props: React.ComponentProps<typeof CommentInputV2>) {
	const newDesign = useNewDesign()
	return newDesign ? <CommentInputV2 {...props} /> : <LegacyCommentInput {...props} />
}
