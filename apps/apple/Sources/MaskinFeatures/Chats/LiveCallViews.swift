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

/// Five bars that dance while the agent speaks and rest low otherwise.
private struct CallWaveform: View {
	let active: Bool
	var height: CGFloat = 24
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	private static let peaks: [CGFloat] = [10, 20, 14, 24, 12]

	var body: some View {
		HStack(spacing: MaskinSpace.s1) {
			ForEach(Array(Self.peaks.enumerated()), id: \.offset) { index, peak in
				WaveBar(peak: peak / 24 * height, rest: 6 / 24 * height, active: active && !reduceMotion, delay: Double(index) * 0.12)
			}
		}
		.frame(height: height)
		.accessibilityHidden(true)
	}

	private struct WaveBar: View {
		let peak: CGFloat
		let rest: CGFloat
		let active: Bool
		let delay: Double
		@State private var up = false

		var body: some View {
			Capsule().fill(MaskinColor.sigInk)
				.frame(width: 3, height: active && up ? peak : rest)
				.onChange(of: active, initial: true) { _, on in
					guard on else {
						withAnimation(MaskinMotion.quick) { up = false }
						return
					}
					withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true).delay(delay)) { up = true }
				}
		}
	}
}

/// Two rings that swell and fade behind the agent while it speaks.
private struct CallPulse: View {
	let active: Bool
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var out = false

	var body: some View {
		ZStack {
			ForEach(0..<2, id: \.self) { index in
				Circle().strokeBorder(MaskinColor.sigInk.opacity(0.55), lineWidth: 1.5)
					.scaleEffect(active && out ? 1.55 : 0.75)
					.opacity(active ? (out ? 0 : 0.55) : 0)
					.animation(
						active && !reduceMotion
							? .easeOut(duration: 2.4).repeatForever(autoreverses: false).delay(Double(index) * 1.2) : .default,
						value: out)
			}
		}
		.onChange(of: active, initial: true) { _, on in out = on && !reduceMotion }
		.accessibilityHidden(true)
	}
}

/// One labelled round control in the dock's bottom row.
private struct CallControl: View {
	enum Emphasis { case quiet, on, inverse, danger }
	let title: String
	let symbol: String
	let emphasis: Emphasis
	let action: () -> Void

	var body: some View {
		Button(action: action) { CallControlLabel(title: title, symbol: symbol, emphasis: emphasis) }
			.buttonStyle(.maskinPressed(.shrink))
	}
}

private struct CallControlLabel: View {
	let title: String
	let symbol: String
	let emphasis: CallControl.Emphasis

	var body: some View {
		VStack(spacing: MaskinSpace.s3) {
			Image(systemName: symbol)
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(foreground)
				.frame(width: callControlSize, height: callControlSize)
				.background(fill, in: Circle())
			Text(title).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
				.multilineTextAlignment(.center).lineLimit(1)
		}
		.frame(maxWidth: .infinity)
		.accessibilityElement(children: .combine)
	}

	private var foreground: Color {
		switch emphasis {
		case .quiet: MaskinColor.ink
		case .on: MaskinColor.sigInk
		case .inverse, .danger: MaskinSurface.onInverse
		}
	}

	private var fill: Color {
		switch emphasis {
		case .quiet: MaskinSurface.fillStrong
		case .on: MaskinColor.sigInk.opacity(0.14)
		case .inverse: MaskinSurface.inverse
		case .danger: MaskinColor.danger
		}
	}
}

/// The call card: it takes the composer's place at the bottom of the thread while a call runs in it.
/// Who the call is with (pulsing while they speak), one state line, a waveform and the clock; the
/// agent's latest words as captions; then Mic, Speaker, Captions, More and End. The chevron folds it
/// to a pill. The conversation itself is the thread above.
struct LiveCallPanel: View {
	let session: LiveMeetingSession
	let mentioned: [MentionedObject]
	let onInvite: () -> Void
	let onOpenObject: (MentionedObject) -> Void
	let onEnd: () -> Void

	var body: some View {
		Group {
			if session.isMinimized {
				LiveCallBar(session: session, onOpen: { session.isMinimized = false }, onEnd: onEnd)
			} else {
				dock
			}
		}
		.animation(MaskinMotion.standard, value: session.isMinimized)
	}

	private var speaking: Bool { session.voice.phase == .speaking && !session.voice.isMuted && !session.voice.isYourTurn }

	private var dock: some View {
		VStack(spacing: MaskinSpace.s7) {
			HStack(spacing: MaskinSpace.s7) {
				ZStack {
					CallPulse(active: speaking).frame(width: callAvatarSize * 0.9, height: callAvatarSize * 0.9)
					ActorAvatar(
						name: session.lead.name, kind: session.lead.kind == .agent ? .agent : .human,
						size: callAvatarSize * 0.9, seed: session.lead.id, working: session.voice.phase == .thinking)
				}
				.frame(width: callAvatarSize, height: callAvatarSize)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(session.lead.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Text(session.statusLine).maskinText(.subhead)
						.foregroundStyle(session.voice.failure == nil ? MaskinColor.ink3 : MaskinColor.danger)
						.lineLimit(2).fixedSize(horizontal: false, vertical: true)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				CallWaveform(active: speaking, height: 28)
				CallClock(session: session)
				Button {
					MaskinHaptics.play(.light)
					session.isMinimized = true
				} label: {
					Image(systemName: "chevron.down").maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.ink)
						.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
						.background(MaskinSurface.fillStrong, in: Circle())
				}
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityLabel("Minimise call")
			}
			if session.showsCaptions { captions }
			controls
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.top, MaskinSpace.s8)
		.padding(.bottom, MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief + MaskinSpace.s4, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.brief + MaskinSpace.s4, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.overlayDim.opacity(0.18), radius: MaskinSpace.s9, y: MaskinSpace.s4)
		.accessibilityElement(children: .contain)
	}

	private var captions: some View {
		Text(session.latestAgentLine ?? "Captions appear here when \(session.lead.name) speaks.")
			.maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
			.lineLimit(3).multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s7).padding(.vertical, MaskinSpace.s5)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.accessibilityLabel("Caption")
	}

	private var controls: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s2) {
			CallControl(
				title: session.voice.isMuted ? "Muted" : "Mic",
				symbol: session.voice.isMuted ? "mic.slash.fill" : "mic.fill",
				emphasis: session.voice.isMuted ? .inverse : .quiet
			) {
				session.toggleMute()
				MaskinHaptics.play(.light)
			}
			CallControl(
				title: session.usesSpeaker ? "Speaker" : "Earpiece",
				symbol: session.usesSpeaker ? "speaker.wave.2.fill" : "ear", emphasis: session.usesSpeaker ? .on : .quiet
			) {
				session.toggleSpeaker()
				MaskinHaptics.play(.light)
			}
			CallControl(
				title: "Captions", symbol: "captions.bubble.fill", emphasis: session.showsCaptions ? .on : .quiet
			) {
				session.showsCaptions.toggle()
				MaskinHaptics.play(.light)
			}
			if session.hasPendingWords {
				CallControl(title: "Send now", symbol: "arrow.up", emphasis: .quiet) { session.sendNow() }
			}
			Menu {
				Button(action: onInvite) { Label("Invite an agent", systemImage: "person.badge.plus") }
				// How the agent's replies are delivered: with breaks to react, or straight through.
				// Only the dictation call paces replies; the Realtime call is already a live conversation.
				if session.isDictating {
					Picker(
						"Pace",
						selection: Binding(get: { session.dictation.pace }, set: { session.dictation.pace = $0 })
					) {
						ForEach(LiveCallPace.allCases) { Text($0.title).tag($0) }
					}
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
}

private let callAvatarSize = MaskinSpace.s14 * 2

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

/// The call as a 64 pt capsule: waveform, who and what's happening, the clock, Mic, End. In the
/// thread it is the folded dock; on every other screen it floats above the tab bar. Tap to go back.
struct LiveCallBar: View {
	let session: LiveMeetingSession
	let onOpen: () -> Void
	let onEnd: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			Button(action: onOpen) {
				HStack(spacing: MaskinSpace.s7) {
					CallWaveform(active: session.voice.phase == .speaking && !session.voice.isMuted, height: 24)
					VStack(alignment: .leading, spacing: 0) {
						Text("Live · \(session.lead.name)").maskinText(.subhead).fontWeight(.bold)
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
		.padding(.leading, MaskinSpace.s9)
		.padding(.trailing, MaskinSpace.s4)
		.frame(height: MaskinSpace.touchMin + MaskinSpace.s9 + MaskinSpace.s4)
		.background(MaskinSurface.card, in: Capsule())
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.overlayDim.opacity(0.18), radius: MaskinSpace.s8, y: MaskinSpace.s4)
	}
}

/// On every other screen while a call runs: tap to go back to it.
struct LiveCallPill: View {
	let session: LiveMeetingSession
	let onOpen: () -> Void
	let onEnd: () -> Void

	var body: some View {
		LiveCallBar(session: session, onOpen: onOpen, onEnd: onEnd)
			.padding(.horizontal, MaskinSpace.s7)
	}
}
