import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The words for a call's state, shared by the banner, the control bar and the pill.
extension LiveMeetingSession {
	var statusLine: String {
		LiveCallStatus.text(
			phase: voice.phase, isMuted: voice.isMuted, failure: voice.failure,
			notice: voice.notice ?? connectionNotice, leadName: lead.name,
			hasWords: !voice.transcript.isEmpty, yourTurn: voice.isYourTurn)
	}

	var title: String { LiveCallStatus.title(kind: kind, leadName: lead.name) }
}

/// What the thread shows while a call has just started and nothing has been said: no typing hint.
struct LiveCallEmptyState: View {
	let session: LiveMeetingSession

	var body: some View {
		VStack(spacing: MaskinSpace.s5) {
			Image(systemName: session.voice.isMuted ? "mic.slash" : "waveform")
				.maskinSymbol(MaskinFontSize.t24, weight: .light)
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityHidden(true)
			Text(session.voice.isMuted ? "You're muted" : "Say something to \(session.lead.name)")
				.maskinText(.headline).foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.center)
			Text(session.voice.isMuted ? "Tap Unmute to talk." : "What you say and what comes back appears here.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.center)
		}
		.frame(maxWidth: .infinity)
		.padding(.vertical, MaskinSpace.s14 * 2)
		.padding(.horizontal, MaskinSpace.s10)
		.accessibilityElement(children: .combine)
	}
}

/// On every other screen while a call runs: a floating bar above the tab bar; tap to go back to it.
struct LiveCallPill: View {
	let session: LiveMeetingSession
	let onOpen: () -> Void
	let onEnd: () -> Void

	var body: some View {
		LiveCallBar(session: session, onOpen: onOpen, onToggleMute: { session.toggleMute() }, onEnd: onEnd)
			.padding(.horizontal, MaskinSpace.s8)
	}
}
