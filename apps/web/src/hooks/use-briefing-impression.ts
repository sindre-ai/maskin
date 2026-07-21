import { trackFypBriefingAudioPlayed, trackFypBriefingRead } from '@/lib/analytics'
import { type RefObject, useEffect } from 'react'

// Wires the two briefing-engagement emit sites for T4's featured briefing card:
//   - `fyp_briefing_read` fires when the card body scrolls past 50% (a sentinel
//     positioned at the midpoint of `bodyRef` enters the viewport).
//   - `fyp_briefing_audio_played` fires when the audio playhead crosses 60s.
// Both events dedupe per briefing per session inside `trackFypBriefing*`, so
// scroll-back, replay, or a card re-mount will not double-count.
//
// Usage from T4's briefing card:
//   const bodyRef = useRef<HTMLDivElement>(null)
//   const audioRef = useRef<HTMLAudioElement>(null)
//   useBriefingImpression({ workspaceId, briefingId, bodyRef, audioEl: audioRef.current })
export function useBriefingImpression(params: {
	workspaceId: string
	briefingId: string | null
	bodyRef: RefObject<HTMLElement | null>
	audioEl: HTMLAudioElement | null
}): void {
	const { workspaceId, briefingId, bodyRef, audioEl } = params

	// Scroll >50% via IntersectionObserver on a sentinel positioned at 50% of
	// the body's height. The sentinel is a 1x1 absolute element appended to the
	// body — no visual impact, no layout impact.
	useEffect(() => {
		if (!briefingId) return
		const body = bodyRef.current
		if (!body) return
		if (typeof IntersectionObserver === 'undefined') return

		const sentinel = document.createElement('div')
		sentinel.setAttribute('aria-hidden', 'true')
		sentinel.style.position = 'absolute'
		sentinel.style.top = '50%'
		sentinel.style.left = '0'
		sentinel.style.width = '1px'
		sentinel.style.height = '1px'
		sentinel.style.pointerEvents = 'none'
		// Preserve `position: relative` if not already set so `top: 50%` on the
		// sentinel resolves against the body, not an ancestor.
		const priorPosition = body.style.position
		if (!priorPosition) body.style.position = 'relative'
		body.appendChild(sentinel)

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						trackFypBriefingRead({ workspace_id: workspaceId, briefing_id: briefingId })
						observer.disconnect()
					}
				}
			},
			{ root: null, threshold: 0 },
		)
		observer.observe(sentinel)

		return () => {
			observer.disconnect()
			sentinel.remove()
			if (!priorPosition) body.style.position = ''
		}
	}, [briefingId, workspaceId, bodyRef])

	// Audio >60s via `timeupdate`. Fires the first time `currentTime` crosses
	// the threshold; the trackFyp* dedupe stops any re-emit if the user
	// scrubs back and replays.
	useEffect(() => {
		if (!briefingId || !audioEl) return
		const onTimeUpdate = () => {
			if (audioEl.currentTime >= 60) {
				trackFypBriefingAudioPlayed({ workspace_id: workspaceId, briefing_id: briefingId })
			}
		}
		audioEl.addEventListener('timeupdate', onTimeUpdate)
		return () => audioEl.removeEventListener('timeupdate', onTimeUpdate)
	}, [briefingId, workspaceId, audioEl])
}
