import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ArrowDown } from 'lucide-react'
import { useCallback, useEffect } from 'react'

interface AskBannerProps {
	agentName: string
	askText: string
	jumpHref: string
	onDecideClick: () => void
	/** Optional — when the banner is aggregating multiple pending steps,
	 *  renders a count badge next to the CTA. `1` or unset renders no badge. */
	pendingCount?: number
	avatarId?: string
	avatarType?: string
}

/**
 * The Loops-detail inline ask banner (D3 of the loops-v4-polish bet). Renders
 * "{agentName} asks — {askText}" plus a Decide ↓ CTA that jumps to the first
 * pending step in the vertical-story spine. Amber-tinted using the same
 * `bg-ask-surface` / `border-ask-border` / `text-warning` tokens as the Objects
 * ask banner and the "waiting on you" pill family.
 *
 * The a11y contract lives one level up: the caller renders this inside a stable
 * `aria-live="polite" aria-atomic="true"` wrapper so screen readers announce
 * the banner appearance without racing the DOM swap. This element is NOT
 * aria-live itself.
 */
export function AskBanner({
	agentName,
	askText,
	jumpHref,
	onDecideClick,
	pendingCount,
	avatarId,
	avatarType,
}: AskBannerProps) {
	const badge = pendingCount && pendingCount > 1 ? `+${pendingCount - 1}` : null

	// Keyboard `d` triggers Decide, matching the inbox-triage modifier-less
	// pattern. Guarded so it never steals from the composer or an EditableTitle:
	// only fires when no editable element (input / textarea / contentEditable)
	// currently owns focus, and never with a modifier held.
	const handleDecide = useCallback(() => {
		onDecideClick()
	}, [onDecideClick])

	useEffect(() => {
		function isEditableTarget(target: EventTarget | null): boolean {
			if (!(target instanceof HTMLElement)) return false
			if (target.isContentEditable) return true
			const tag = target.tagName
			return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== 'd' && e.key !== 'D') return
			if (e.metaKey || e.ctrlKey || e.altKey) return
			if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return
			e.preventDefault()
			handleDecide()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [handleDecide])

	return (
		<section
			aria-label="Pending ask"
			data-testid="ask-banner"
			className="flex flex-wrap items-center gap-2 rounded-[11px] border border-ask-border bg-ask-surface px-[11px] py-[9px]"
		>
			<ActorAvatar
				id={avatarId}
				name={agentName}
				type={avatarType ?? 'agent'}
				size="sm"
				className="size-5 shrink-0 text-[8.5px]"
			/>
			<p className="min-w-0 flex-1 truncate text-[11.5px] leading-[1.45] text-muted-foreground">
				<span className="font-bold text-foreground">{agentName} asks</span>
				{' — '}
				{askText}
			</p>
			{badge && (
				<span
					className={cn(
						'shrink-0 rounded-full border border-ask-border bg-ask-surface px-2 py-0.5',
						'font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-warning',
					)}
					aria-label={`${pendingCount} pending`}
				>
					{badge}
				</span>
			)}
			<Button
				size="sm"
				onClick={handleDecide}
				className="h-[26px] shrink-0 gap-1.5 rounded-lg px-[11px] text-[11.5px] font-semibold"
				data-ask-banner-decide
				data-jump-href={jumpHref}
			>
				Decide
				<ArrowDown size={12} />
			</Button>
		</section>
	)
}
