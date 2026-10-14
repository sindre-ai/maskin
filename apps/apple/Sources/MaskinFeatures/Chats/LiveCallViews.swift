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

/// A round call control: 40 pt, with the 44 pt hit area the system adds around a button.
private let callControlSize = MaskinSpace.s14 + MaskinSpace.s4

private struct CallClock: View {
	let session: LiveMeetingSession
	var body: some View {
		TimelineView(.periodic(from: .now, by: 1)) { context in
			Text(LiveMeetingFormat.duration(session.elapsed(at: context.date)))
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink3).monospacedDigit()
		}
	}
}

/// A round mute button, the same in the banner, the bar and the pill.
private struct MuteButton: View {
	let session: LiveMeetingSession
	var body: some View {
		Button {
			session.toggleMute()
			MaskinHaptics.play(.light)
		} label: {
			Image(systemName: session.voice.isMuted ? "mic.slash.fill" : "mic.fill")
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(session.voice.isMuted ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(width: callControlSize, height: callControlSize)
				.background(session.voice.isMuted ? MaskinSurface.inverse : MaskinSurface.fillStrong, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(session.voice.isMuted ? "Unmute" : "Mute")
	}
}

private struct EndButton: View {
	let action: () -> Void
	var body: some View {
		Button {
			MaskinHaptics.play(.medium)
			action()
		} label: {
			Image(systemName: "phone.down.fill")
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: callControlSize, height: callControlSize)
				.background(MaskinColor.danger, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("End call")
	}
}

/// The one call surface: it takes the composer's place at the bottom of the thread while a call runs
/// in it. Who the call is with, how long it has gone, one unambiguous state line, and the controls
/// (Mute, Send now when words are pending, More, End). The conversation itself is the thread above.
struct LiveCallPanel: View {
	let session: LiveMeetingSession
	let mentioned: [MentionedObject]
	let onInvite: () -> Void
	let onOpenObject: (MentionedObject) -> Void
	let onEnd: () -> Void

	var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			HStack(spacing: MaskinSpace.s6) {
				ActorAvatar(
					name: session.lead.name, kind: session.lead.kind == .agent ? .agent : .human,
					size: callAvatarSize, seed: session.lead.id, working: session.voice.phase == .thinking)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(session.lead.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(2)
					Text(session.statusLine).maskinText(.subhead)
						.foregroundStyle(session.voice.failure == nil ? MaskinColor.ink3 : MaskinColor.danger)
						.fixedSize(horizontal: false, vertical: true)
					if !session.routeName.isEmpty {
						Label(session.routeName, systemImage: "speaker.wave.2")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				CallClock(session: session)
			}
			HStack(alignment: .top, spacing: MaskinSpace.s5) {
				CallControl(
					title: session.voice.isMuted ? "Unmute" : "Mute",
					symbol: session.voice.isMuted ? "mic.slash.fill" : "mic.fill",
					emphasis: session.voice.isMuted ? .inverse : .quiet
				) {
					session.toggleMute()
					MaskinHaptics.play(.light)
				}
				if session.hasPendingWords {
					CallControl(title: "Send now", symbol: "arrow.up", emphasis: .quiet) {
						session.voice.sendNow()
					}
				}
				Menu {
					Button(action: onInvite) { Label("Invite an agent", systemImage: "person.badge.plus") }
					// How the agent's replies are delivered: with breaks to react, or straight through.
					Picker(
						"Pace",
						selection: Binding(get: { session.voice.pace }, set: { session.voice.pace = $0 })
					) {
						ForEach(LiveCallPace.allCases) { Text($0.title).tag($0) }
					}
					if !mentioned.isEmpty {
						Section("Mentioned in this call") {
							ForEach(mentioned.prefix(8)) { object in
								Button { onOpenObject(object) } label: { Label(object.title, systemImage: "doc.text") }
							}
						}
					}
				} label: {
					CallControlLabel(title: "More", symbol: "ellipsis", emphasis: .quiet)
				}
				.accessibilityLabel("More call options")
				CallControl(title: "End", symbol: "phone.down.fill", emphasis: .danger) {
					MaskinHaptics.play(.medium)
					onEnd()
				}
			}
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

private let callAvatarSize = MaskinSpace.s14 + MaskinSpace.s9

private struct CallControl: View {
	let title: String
	let symbol: String
	let emphasis: CallControlLabel.Emphasis
	let action: () -> Void

	var body: some View {
		Button(action: action) { CallControlLabel(title: title, symbol: symbol, emphasis: emphasis) }
			.buttonStyle(.maskinPressed(.shrink))
	}
}

/// A round icon with its name under it, so every control reads without guessing.
private struct CallControlLabel: View {
	enum Emphasis { case quiet, inverse, danger }
	let title: String
	let symbol: String
	let emphasis: Emphasis

	var body: some View {
		VStack(spacing: MaskinSpace.s2) {
			Image(systemName: symbol)
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(emphasis == .quiet ? MaskinColor.ink : MaskinSurface.onInverse)
				.frame(width: callControlSize, height: callControlSize)
				.background(fill, in: Circle())
			Text(title).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
				.multilineTextAlignment(.center)
		}
		.frame(maxWidth: .infinity)
		.accessibilityElement(children: .combine)
	}

	private var fill: Color {
		switch emphasis {
		case .quiet: MaskinSurface.fillStrong
		case .inverse: MaskinSurface.inverse
		case .danger: MaskinColor.danger
		}
	}
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

/// On every other screen while a call runs: tap to go back to it.
struct LiveCallPill: View {
	let session: LiveMeetingSession
	let onOpen: () -> Void
	let onEnd: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Button(action: onOpen) {
				HStack(spacing: MaskinSpace.s4) {
					Image(systemName: "waveform").foregroundStyle(MaskinColor.sigInk).accessibilityHidden(true)
					VStack(alignment: .leading, spacing: 0) {
						Text("Live · \(session.lead.name)").maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink).lineLimit(1)
						Text(session.statusLine).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s2)
					CallClock(session: session)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Live call with \(session.lead.name), return to the call")
			MuteButton(session: session)
			EndButton(action: onEnd)
		}
		.padding(.horizontal, MaskinSpace.s6)
		.padding(.vertical, MaskinSpace.s3)
		.background(MaskinSurface.card, in: Capsule())
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		.padding(.horizontal, MaskinSpace.s7)
	}
}
