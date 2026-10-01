import { cn } from '@/lib/cn'
import { Phone } from 'lucide-react'

// The "Voice-enabled" badge in the KIND row of an agent — small brand-subtle
// chip beside the role label, per the design SPEC. Purely visual; discovery
// only. Presence tracks actors.metadata.voice_enabled; write path is the
// Voice-mode toggle in the agent settings surface, session mint is Task 1's
// POST /api/voice-sessions.
export function VoiceEnabledBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center gap-1 rounded-[5px] bg-brand-subtle px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-[0.09em] text-brand-subtle-foreground',
				className,
			)}
			// The label itself is the aria-label — the icon is decorative.
			aria-label="Voice-enabled agent"
			title="Voice-enabled — a workspace member can hold a live voice call with this agent"
		>
			<Phone size={9} strokeWidth={2.5} aria-hidden="true" />
			Voice
		</span>
	)
}
