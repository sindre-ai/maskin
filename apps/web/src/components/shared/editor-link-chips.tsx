import { renderLinkedChip, renderLinkedGithubChip } from '@/components/chat/linked-object-preview'
import { EditorChipContext } from '@/components/chat/linked-object-reference'
import {
	MAX_OBJECT_FETCHES,
	githubTargetOf,
	isOtherWorkspace,
	targetOfHref,
} from '@/lib/linked-objects'
import type { LinkChipHost } from '@maskin/markdown/react/editor'
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

// A tap cannot both open a link and place the cursor, so a phone or a touch screen keeps plain
// links in the editor.
const CHIPS_QUERY = '(min-width: 640px) and (pointer: fine)'

function useChipsCapable() {
	return useSyncExternalStore(
		(onChange) => {
			const mql = window.matchMedia(CHIPS_QUERY)
			mql.addEventListener('change', onChange)
			return () => mql.removeEventListener('change', onChange)
		},
		() => window.matchMedia(CHIPS_QUERY).matches,
		() => false,
	)
}

/**
 * The links the chat chips recognise, with what drawing each costs: an object, loop, trigger,
 * agent or chat of this workspace is one lookup (the shared cache, at most {@link MAX_OBJECT_FETCHES}
 * per body), a link into another workspace and a GitHub pull request or issue cost none. A file
 * and any other address stay plain links.
 */
function chipFor(href: string, workspaceId: string) {
	if (githubTargetOf(href)) return {}
	const target = targetOfHref(href)
	if (!target || target.kind === 'file') return null
	if (isOtherWorkspace(target, workspaceId)) return {}
	return { lookup: `${target.kind}:${target.id}` }
}

/**
 * The chat's chip for a link, named with the link text the author wrote (the object's own name for
 * a bare pasted address), with no preview and no phone sheet, and not a tab stop of its own.
 */
function EditorLinkChip({
	workspaceId,
	href,
	text,
	bare,
}: {
	workspaceId: string
	href: string
	text: string
	bare: boolean
}) {
	const root = useRef<HTMLSpanElement>(null)
	// The editor owns Tab and the arrow keys: keyboard users reach a link by arrowing to it.
	useEffect(() => {
		const el = root.current
		if (!el) return
		const untab = () => {
			for (const focusable of el.querySelectorAll('a, button'))
				focusable.setAttribute('tabindex', '-1')
		}
		untab()
		const observer = new MutationObserver(untab)
		observer.observe(el, { childList: true, subtree: true })
		return () => observer.disconnect()
	}, [])

	const github = githubTargetOf(href)
	const target = targetOfHref(href)
	const fallback = <a href={href}>{text}</a>
	let chip: ReactNode = fallback
	if (github) chip = renderLinkedGithubChip(github, href)
	else if (target) chip = renderLinkedChip(target, fallback, { workspaceId, cardFollows: false })
	return (
		<EditorChipContext.Provider value={{ label: bare ? undefined : text }}>
			<span ref={root}>{chip}</span>
		</EditorChipContext.Provider>
	)
}

interface MountedChip {
	key: number
	href: string
	text: string
	bare: boolean
}

/**
 * Link chips for the live editor. `host` goes to the editor's `linkChips` prop (null where the
 * editor keeps plain links); `layer` is rendered next to the editor and draws each chip into the
 * element the editor made for it, through a portal, so the chips read the app's providers and the
 * shared lookup cache like any chip in chat.
 */
export function useEditorLinkChips(workspaceId: string | undefined) {
	const capable = useChipsCapable()
	const [mounted, setMounted] = useState<ReadonlyMap<HTMLElement, MountedChip>>(new Map())
	const nextKey = useRef(0)

	const host = useMemo<LinkChipHost | null>(() => {
		if (!workspaceId || !capable) return null
		// The editor calls these while it updates its view, so state is set after that settles.
		return {
			maxLookups: MAX_OBJECT_FETCHES,
			chipFor: (href) => chipFor(href, workspaceId),
			mount: (container, link) => {
				const key = nextKey.current++
				queueMicrotask(() => setMounted((prev) => new Map(prev).set(container, { key, ...link })))
			},
			unmount: (container) => {
				queueMicrotask(() =>
					setMounted((prev) => {
						if (!prev.has(container)) return prev
						const next = new Map(prev)
						next.delete(container)
						return next
					}),
				)
			},
		}
	}, [workspaceId, capable])

	const layer = workspaceId
		? [...mounted].map(([container, chip]) =>
				createPortal(
					<EditorLinkChip
						workspaceId={workspaceId}
						href={chip.href}
						text={chip.text}
						bare={chip.bare}
					/>,
					container,
					String(chip.key),
				),
			)
		: null
	return { host, layer }
}
