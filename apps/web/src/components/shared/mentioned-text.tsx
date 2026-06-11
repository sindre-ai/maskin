import type { ActorListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Fragment, type ReactNode, useMemo } from 'react'

interface MentionedTextProps {
	content: string
	actors: ActorListItem[]
	/** Class applied to each highlighted @mention span. */
	mentionClassName?: string
	/** When provided, @mentions are rendered as clickable buttons. */
	onMentionClick?: (actor: ActorListItem) => void
}

const DEFAULT_MENTION_CLASS =
	'inline-flex items-center rounded px-1 py-0.5 text-xs font-medium bg-primary/10 text-primary'

/**
 * Renders text with @{actor.name} substrings highlighted as styled chips.
 * Matches the longest known actor name first so multi-word names ("@Senior Developer")
 * aren't truncated to just the first token.
 */
export function MentionedText({
	content,
	actors,
	mentionClassName = DEFAULT_MENTION_CLASS,
	onMentionClick,
}: MentionedTextProps) {
	const sortedNames = useMemo(
		() =>
			actors
				.map((a) => a.name)
				.filter(Boolean)
				.sort((a, b) => b.length - a.length),
		[actors],
	)

	const actorsByName = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const a of actors) if (a.name) map.set(a.name, a)
		return map
	}, [actors])

	const parts = useMemo<
		Array<{ type: 'text' | 'mention'; text: string; actor?: ActorListItem; key: string }>
	>(() => {
		const out: Array<{
			type: 'text' | 'mention'
			text: string
			actor?: ActorListItem
			key: string
		}> = []
		let i = 0
		while (i < content.length) {
			if (content[i] === '@') {
				const match = sortedNames.find((name) => {
					if (!content.startsWith(`@${name}`, i)) return false
					const after = content[i + 1 + name.length]
					return after === undefined || !/\w/.test(after)
				})
				if (match) {
					out.push({
						type: 'mention',
						text: `@${match}`,
						actor: actorsByName.get(match),
						key: `m-${i}`,
					})
					i += match.length + 1
					continue
				}
			}
			const nextAt = content.indexOf('@', i + 1)
			const end = nextAt === -1 ? content.length : nextAt
			out.push({ type: 'text', text: content.slice(i, end), key: `t-${i}` })
			i = end
		}
		return out
	}, [content, sortedNames, actorsByName])

	return (
		<>
			{parts.map((p): ReactNode => {
				if (p.type === 'mention') {
					if (onMentionClick && p.actor) {
						const actor = p.actor
						return (
							<button
								key={p.key}
								type="button"
								onClick={() => onMentionClick(actor)}
								className={cn(
									mentionClassName,
									'cursor-pointer hover:opacity-80 transition-opacity',
								)}
							>
								{p.text}
							</button>
						)
					}
					return (
						<span key={p.key} className={cn(mentionClassName)}>
							{p.text}
						</span>
					)
				}
				return <Fragment key={p.key}>{p.text}</Fragment>
			})}
		</>
	)
}
