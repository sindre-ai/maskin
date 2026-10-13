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
				.maskinText(.mono).foregroundStyle(MaskinColor.ink3).monospacedDigit()
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

/// Pinned under the navigation bar while a call is running in this thread: who it is with, how long,
/// what it is doing, and Mute / End. Invite and the objects the call has mentioned are in the menu.
struct LiveCallBanner: View {
	let session: LiveMeetingSession
	let mentioned: [MentionedObject]
	let onInvite: () -> Void
	let onOpenObject: (MentionedObject) -> Void
	let onEnd: () -> Void
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "waveform")
				.maskinSymbol(MaskinFontSize.t16, weight: .semibold)
				.foregroundStyle(MaskinColor.sigInk)
				.symbolEffect(.variableColor.iterative, isActive: session.voice.phase == .speaking && !reduceMotion)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(spacing: MaskinSpace.s3) {
					MonoLabel(session.title, color: MaskinColor.sigInk)
					CallClock(session: session)
				}
				Text(session.statusLine).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(2)
			}
			Spacer(minLength: MaskinSpace.s3)
			MuteButton(session: session)
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
				Image(systemName: "ellipsis")
					.maskinSymbol(MaskinFontSize.t16, weight: .medium)
					.foregroundStyle(MaskinColor.ink)
					.frame(width: callControlSize, height: callControlSize)
					.background(MaskinSurface.fillStrong, in: Circle())
			}
			.accessibilityLabel("Call options")
			EndButton(action: onEnd)
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.vertical, MaskinSpace.s4)
		.background(MaskinSurface.card)
		.overlay(alignment: .bottom) { Rectangle().fill(MaskinSurface.line).frame(height: 1) }
		.accessibilityElement(children: .contain)
	}
}

/// Takes the composer's place while a call is running in this thread.
struct LiveControlBar: View {
	let session: LiveMeetingSession
	let onEnd: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s6) {
			MuteButton(session: session)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(session.statusLine).maskinText(.subhead).foregroundStyle(MaskinColor.ink).lineLimit(2)
				if !session.routeName.isEmpty {
					Label(session.routeName, systemImage: "speaker.wave.2")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if !session.voice.transcript.isEmpty, session.voice.phase != .speaking {
				Button("Send now") { session.voice.sendNow() }.buttonStyle(.bordered)
			}
			EndButton(action: onEnd)
		}
		.padding(MaskinSpace.s6)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
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
						Text(session.title).maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk)
						Text(session.statusLine).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s2)
					CallClock(session: session)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("\(session.title), return to the call")
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
