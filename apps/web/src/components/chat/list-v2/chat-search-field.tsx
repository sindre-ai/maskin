import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import {
	type OperatorToken,
	SEARCH_IS_VALUES,
	SEARCH_OPERATOR_HINTS,
	operatorBeingTyped,
} from '@/lib/chat-list-v2'
import { cn } from '@/lib/cn'
import { Search } from 'lucide-react'
import { type KeyboardEvent, type Ref, useId, useMemo, useState } from 'react'

interface Suggestion {
	/** What the list shows. */
	label: string
	/** What replaces the word being typed. */
	insert: string
	hint?: string
}

const MAX_SUGGESTIONS = 8

/** The words the suggestion list offers for the operator being typed. */
export function suggestionsFor(
	token: OperatorToken | null,
	text: string,
	{ agents, teams }: { agents: string[]; teams: string[] },
): Suggestion[] {
	if (text === '') {
		return SEARCH_OPERATOR_HINTS.map((h) => ({ label: h.token, insert: h.token, hint: h.hint }))
	}
	if (!token) return []
	const partial = token.partial.toLowerCase()
	const prefix = token.operator === 'agent' ? '@' : `${token.operator}:`
	const pool =
		token.operator === 'is' ? [...SEARCH_IS_VALUES] : token.operator === 'team' ? teams : agents
	return pool
		.filter((name) => name.toLowerCase().startsWith(partial) && name.toLowerCase() !== partial)
		.slice(0, MAX_SUGGESTIONS)
		.map((name) => {
			const word = /\s/.test(name) ? `"${name}"` : name
			return { label: `${prefix}${name}`, insert: `${prefix}${word}` }
		})
}

/**
 * The list's search input. Empty with focus it lists the operators with a hint each; typing one
 * (@, from:, with:, team:, is:) suggests agents, teams or states. Choosing a suggestion swaps the
 * word being typed. The words themselves go to the server as typed.
 */
export function ChatSearchField({
	workspaceId,
	value,
	onChange,
	onFocusChange,
	inputRef,
	className,
	wrapperClassName,
	inputClassName,
	children,
}: {
	workspaceId: string
	value: string
	onChange: (next: string) => void
	onFocusChange?: (focused: boolean) => void
	inputRef?: Ref<HTMLInputElement>
	/** The label wrapping the icon and input. */
	className?: string
	/** The box the suggestion list hangs from; sets how much room the field takes. */
	wrapperClassName?: string
	inputClassName?: string
	children?: React.ReactNode
}) {
	const [focused, setFocused] = useState(false)
	const [active, setActive] = useState(0)
	const listId = useId()
	const { data: actors } = useActors(workspaceId)
	// Teams are the tags on chats already loaded for the list (same query, so no extra request).
	const { data: chats } = useConversationsInfinite(workspaceId, {
		scope: 'priority',
		hide_quiet: true,
	})
	const agents = useMemo(
		() => (actors ?? []).filter((a) => a.type === 'agent').map((a) => a.name),
		[actors],
	)
	const everyone = useMemo(() => (actors ?? []).map((a) => a.name), [actors])
	const teams = useMemo(
		() =>
			[
				...new Set(
					(chats?.pages ?? []).flatMap((p) => p.conversations.flatMap((c) => c.tags ?? [])),
				),
			].sort(),
		[chats],
	)

	const token = operatorBeingTyped(value)
	const suggestions = useMemo(
		() =>
			suggestionsFor(token, value, {
				agents: token?.operator === 'agent' ? agents : everyone,
				teams,
			}),
		[token, value, agents, everyone, teams],
	)
	const open = focused && suggestions.length > 0

	const choose = (s: Suggestion) => {
		// An empty field takes the operator itself; a typed one swaps the word being typed.
		const next =
			value === '' ? s.insert : `${value.slice(0, token?.start ?? value.length)}${s.insert}`
		onChange(/[:@]$/.test(next) ? next : `${next} `)
		setActive(0)
	}

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (open && e.key === 'ArrowDown') {
			e.preventDefault()
			setActive((i) => (i + 1) % suggestions.length)
		} else if (open && e.key === 'ArrowUp') {
			e.preventDefault()
			setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
		} else if (open && e.key === 'Enter' && value !== '') {
			e.preventDefault()
			choose(suggestions[Math.min(active, suggestions.length - 1)])
		}
	}

	return (
		<div className={cn('relative min-w-0 flex-1', wrapperClassName)}>
			<label className={className}>
				<Search size={14} aria-hidden className="shrink-0" />
				<input
					ref={inputRef}
					type="search"
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={open ? `${listId}-${active}` : undefined}
					value={value}
					onChange={(e) => {
						onChange(e.target.value)
						setActive(0)
					}}
					onKeyDown={onKeyDown}
					onFocus={() => {
						setFocused(true)
						onFocusChange?.(true)
					}}
					onBlur={() => {
						setFocused(false)
						onFocusChange?.(false)
					}}
					placeholder="Search chats"
					aria-label="Search chats"
					className={inputClassName}
				/>
			</label>
			{children}
			{open ? (
				// biome-ignore lint/a11y/useFocusableInteractive: a combobox listbox keeps focus in the input and points at the active option
				<ul
					id={listId}
					// biome-ignore lint/a11y/useSemanticElements: a select cannot hold hints or open under a search field
					// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox pattern needs a listbox here
					role="listbox"
					aria-label="Search operators"
					className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{suggestions.map((s, i) => (
						// biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant on the input
						<li
							key={s.label}
							id={`${listId}-${i}`}
							// biome-ignore lint/a11y/useSemanticElements: an option element only exists inside a select
							// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the combobox pattern needs options in the listbox
							role="option"
							aria-selected={i === active}
							// Mouse down, not click: the input must not lose focus first, or the list closes.
							onMouseDown={(e) => {
								e.preventDefault()
								choose(s)
							}}
							className={cn(
								'flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px]',
								i === active && 'bg-accent',
							)}
						>
							<span className="font-medium text-foreground">{s.label}</span>
							{s.hint ? <span className="truncate text-muted-foreground">{s.hint}</span> : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}
