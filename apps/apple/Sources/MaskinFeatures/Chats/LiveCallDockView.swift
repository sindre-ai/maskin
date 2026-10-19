import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// The v5 live call: a card docked above the composer, folded to a bar, and the same bar floating
// over the other screens. Everything here is a skin over `LiveMeetingSession`; the audio, the
// voice loop and the call's lifetime are untouched.

// MARK: - Sizes

private enum CallMetrics {
	static let cardRadius = MaskinSpace.s13
	static let stage = MaskinSpace.s14 * 2 - MaskinSpace.s2
	static let avatar = MaskinSpace.s12 * 2 + MaskinSpace.s3
	static let control = MaskinSpace.s14 + MaskinSpace.s4 + MaskinSpace.s3
	static let barControl = MaskinSpace.s14 + MaskinSpace.s4 + MaskinSpace.s1
	static let barHeight = MaskinSpace.s14 * 2
	static let chevron = MaskinSpace.s12 + MaskinSpace.s4 + MaskinSpace.s1 * 3
}

// MARK: - Pieces

/// Five bars that move while the agent speaks and rest low otherwise.
struct CallWaveform: View {
	let active: Bool
	var height: CGFloat = MaskinSpace.s12 + MaskinSpace.s2
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	private static let peaks: [CGFloat] = [
		MaskinSpace.s5, MaskinSpace.s11, MaskinSpace.s8, MaskinSpace.s12, MaskinSpace.s7,
	]
	private static let rest = MaskinSpace.s3

	var body: some View {
		TimelineView(.animation(paused: !active || reduceMotion)) { context in
			HStack(spacing: MaskinSpace.s1) {
				ForEach(0..<Self.peaks.count, id: \.self) { index in
					Capsule()
						.fill(MaskinColor.sig)
						.frame(width: MaskinSpace.s1 * 1.5, height: barHeight(index, at: context.date))
				}
			}
			.frame(height: height)
		}
		.accessibilityHidden(true)
	}

	private func barHeight(_ index: Int, at date: Date) -> CGFloat {
		guard active else { return Self.rest }
		let phase = date.timeIntervalSinceReferenceDate / 0.9 * .pi * 2 + Double(index) * 0.75
		let level = (sin(phase) + 1) / 2
		return Self.rest + (Self.peaks[index] - Self.rest) * level
	}
}

/// The agent's avatar with two rings that spread while it speaks.
private struct CallStage: View {
	let session: LiveMeetingSession
	let speaking: Bool
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		ZStack {
			TimelineView(.animation(paused: !speaking || reduceMotion)) { context in
				ZStack {
					ring(at: context.date, delay: 0)
					ring(at: context.date, delay: 1.2)
				}
			}
			ActorAvatar(
				name: session.lead.name, kind: session.lead.kind == .agent ? .agent : .human,
				size: CallMetrics.avatar, seed: session.lead.id, working: session.voice.phase == .thinking)
		}
		.frame(width: CallMetrics.stage, height: CallMetrics.stage)
		.accessibilityHidden(true)
	}

	private func ring(at date: Date, delay: Double) -> some View {
		let progress = speaking ? ((date.timeIntervalSinceReferenceDate + delay) / 2.4).truncatingRemainder(dividingBy: 1) : 0
		return Circle()
			.strokeBorder(MaskinColor.sig.opacity(0.55), lineWidth: MaskinSpace.s1 * 0.75)
			.frame(width: CallMetrics.avatar, height: CallMetrics.avatar)
			.scaleEffect(1 + 0.25 * progress)
			.opacity(speaking ? 1 - progress : 0)
	}
}

/// The running time, "0:42".
struct CallTimer: View {
	let session: LiveMeetingSession
	var body: some View {
		TimelineView(.periodic(from: .now, by: 1)) { context in
			Text(LiveMeetingFormat.duration(session.elapsed(at: context.date)))
				.maskinText(.mono).fontWeight(.semibold).foregroundStyle(MaskinColor.ink2).monospacedDigit()
		}
	}
}

private struct CallRoundButton: View {
	enum Style { case quiet, inverse, tint, danger }
	let symbol: String
	let style: Style
	let size: CGFloat
	let label: String
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(style == .danger ? .medium : .light)
			action()
		} label: {
			Image(systemName: symbol)
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(foreground)
				.frame(width: size, height: size)
				.background(background, in: Circle())
				.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
				.contentShape(Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(label)
	}

	private var foreground: Color {
		switch style {
		case .quiet: MaskinColor.ink
		case .inverse, .danger: MaskinSurface.onInverse
		case .tint: MaskinColor.patina700
		}
	}

	private var background: Color {
		switch style {
		case .quiet: MaskinSurface.fillStrong
		case .inverse: MaskinColor.patina900
		case .tint: MaskinColor.sigTint
		case .danger: MaskinColor.danger
		}
	}
}

/// A round control with its name under it.
private struct CallControl: View {
	let title: String
	let symbol: String
	let style: CallRoundButton.Style
	let action: () -> Void

	var body: some View {
		VStack(spacing: MaskinSpace.s2) {
			CallRoundButton(
				symbol: symbol, style: style, size: CallMetrics.control, label: title, action: action)
				.frame(width: CallMetrics.control, height: CallMetrics.control)
			Text(title).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
		}
		.frame(maxWidth: .infinity)
	}
}

// MARK: - The docked card

/// The call in its chat: who, how it stands, the timer; optional captions; for the briefing the
/// decision on the table; and Mic, Speaker, Captions, Pull up, End. Folding it shows `LiveCallBar`.
struct LiveCallDock: View {
	let session: LiveMeetingSession
	let center: LiveCallCenter
	let mentioned: [MentionedObject]
	let onInvite: () -> Void
	let onOpenObject: (MentionedObject) -> Void
	let onPullUp: () -> Void
	let onEnd: () -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var speaking: Bool { session.voice.phase == .speaking && !session.voice.isMuted }

	var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			header
			if center.dock.captionsOn { captions }
			if session.kind == .dailyBriefing, let runtime, let decision = LiveCallDecision.current(in: runtime.forYou.store.entries) {
				DecisionOnTheTable(decision: decision) { option in
					runtime.forYou.store.choose(option, on: decision.card)
				}
			}
			controls
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.top, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s5)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: CallMetrics.cardRadius, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: CallMetrics.cardRadius, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.ink.opacity(0.12), radius: MaskinSpace.s9, y: MaskinSpace.s4)
		.accessibilityElement(children: .contain)
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s7) {
			Button {
				if speaking { session.voice.interrupt() }
			} label: {
				CallStage(session: session, speaking: speaking)
			}
			.buttonStyle(.plain)
			.accessibilityElement()
			.accessibilityLabel(session.lead.name)
			.accessibilityHint(speaking ? "Interrupts the reply" : "")
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(session.lead.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(session.statusLine).maskinText(.subhead)
					.foregroundStyle(session.voice.failure == nil ? MaskinColor.ink3 : MaskinColor.danger)
					.lineLimit(2)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			CallWaveform(active: speaking, height: MaskinSpace.s14 - MaskinSpace.s2)
			CallTimer(session: session)
			Button {
				MaskinHaptics.play(.light)
				withAnimation(MaskinMotion.standard) { center.dock.toggleCollapsed() }
			} label: {
				Image(systemName: "chevron.down")
					.maskinSymbol(MaskinFontSize.t14, weight: .bold)
					.foregroundStyle(MaskinColor.patina900)
					.frame(width: CallMetrics.chevron, height: CallMetrics.chevron)
					.background(MaskinSurface.fillStrong, in: Circle())
					.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityLabel("Collapse call")
		}
	}

	private var captions: some View {
		Text(
			LiveCallCaption.text(
				phase: session.voice.phase, agentSpeaking: session.voice.speakingText,
				yourWords: session.voice.transcript,
				lastAgentLine: session.voice.turns.last { !$0.isYou }?.text, leadName: session.lead.name)
		)
		.maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
		.lineLimit(4)
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, MaskinSpace.s7).padding(.vertical, MaskinSpace.s5)
		.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.accessibilityLabel("Captions")
		.transition(.opacity)
	}

	private var controls: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s1) {
			CallControl(
				title: LiveCallDockState.micLabel(isMuted: session.voice.isMuted),
				symbol: session.voice.isMuted ? "mic.slash.fill" : "mic.fill",
				style: session.voice.isMuted ? .inverse : .quiet
			) { center.toggleMute() }
			CallControl(
				title: center.dock.speakerLabel, symbol: center.dock.speakerOn ? "speaker.wave.2.fill" : "ear",
				style: center.dock.speakerOn ? .tint : .quiet
			) { center.toggleSpeaker() }
			CallControl(
				title: "Captions", symbol: "captions.bubble.fill", style: center.dock.captionsOn ? .tint : .quiet
			) { withAnimation(MaskinMotion.standard) { center.dock.toggleCaptions() } }
			CallControl(title: "Pull up", symbol: "magnifyingglass", style: .quiet, action: onPullUp)
			moreMenu
			CallControl(title: "End", symbol: "phone.down.fill", style: .danger, action: onEnd)
		}
	}

	/// Invite, Pace and the objects the call has mentioned: the call's existing options.
	private var moreMenu: some View {
		Menu {
			if session.hasPendingWords {
				Button { session.voice.sendNow() } label: { Label("Send now", systemImage: "arrow.up") }
			}
			Button(action: onInvite) { Label("Invite an agent", systemImage: "person.badge.plus") }
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
			VStack(spacing: MaskinSpace.s2) {
				Image(systemName: "ellipsis")
					.maskinSymbol(MaskinFontSize.t16, weight: .medium)
					.foregroundStyle(MaskinColor.ink)
					.frame(width: CallMetrics.control, height: CallMetrics.control)
					.background(MaskinSurface.fillStrong, in: Circle())
				Text("More").maskinText(.caption).foregroundStyle(MaskinColor.ink3)
			}
			.frame(maxWidth: .infinity)
		}
		.accessibilityLabel("More call options")
	}
}

/// "DECIDING NOW": the open decision with its answers as buttons.
private struct DecisionOnTheTable: View {
	let decision: LiveCallDecision
	let choose: (DecisionOption) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(decision.label).maskinText(.microLabelMicro).foregroundStyle(MaskinColor.patina700)
			Text(decision.ask).maskinText(.subhead).fontWeight(.bold).foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
			HStack(spacing: MaskinSpace.s4) {
				Button { choose(decision.main) } label: {
					Text(decision.main.label).maskinText(.subhead).fontWeight(.bold)
						.foregroundStyle(MaskinSurface.onInverse)
						.multilineTextAlignment(.center)
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
						.padding(.horizontal, MaskinSpace.s7)
						.background(MaskinColor.patina900, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				}
				.layoutPriority(1.4)
				ForEach(decision.alternatives) { option in
					Button { choose(option) } label: {
						Text(option.label).maskinText(.caption).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink)
							.multilineTextAlignment(.center)
							.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
							.padding(.horizontal, MaskinSpace.s4)
							.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
					}
				}
			}
			.buttonStyle(.maskinPressed(.shrink))
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

// MARK: - The bar

/// The call as a compact bar: folded in its thread, and floating above the tab bar elsewhere.
/// Tapping the left part opens the call (unfolds it, or goes back to its thread).
struct LiveCallBar: View {
	let session: LiveMeetingSession
	let onOpen: () -> Void
	let onToggleMute: () -> Void
	let onEnd: () -> Void

	private var speaking: Bool { session.voice.phase == .speaking && !session.voice.isMuted }

	var body: some View {
		HStack(spacing: MaskinSpace.s7) {
			Button(action: onOpen) {
				HStack(spacing: MaskinSpace.s7) {
					CallWaveform(active: speaking)
					VStack(alignment: .leading, spacing: 0) {
						Text("Live · \(session.lead.name)").maskinText(.subhead).fontWeight(.bold)
							.foregroundStyle(MaskinColor.ink).lineLimit(1)
						Text(session.statusLine).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s2)
					CallTimer(session: session)
				}
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Live call with \(session.lead.name), open the call")
			CallRoundButton(
				symbol: session.voice.isMuted ? "mic.slash.fill" : "mic.fill",
				style: session.voice.isMuted ? .inverse : .quiet, size: CallMetrics.barControl,
				label: session.voice.isMuted ? "Unmute" : "Mute", action: onToggleMute)
			CallRoundButton(
				symbol: "phone.down.fill", style: .danger, size: CallMetrics.barControl, label: "End call",
				action: onEnd)
		}
		.padding(.leading, MaskinSpace.s9)
		.padding(.trailing, MaskinSpace.s4)
		.frame(height: CallMetrics.barHeight)
		.background(MaskinSurface.card, in: Capsule())
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		.shadow(color: MaskinColor.ink.opacity(0.14), radius: MaskinSpace.s8, y: MaskinSpace.s3)
		.accessibilityElement(children: .contain)
	}
}

// MARK: - The chat header

/// In the chat header while a call runs: the timer and a red hang-up, in place of the Live button.
struct LiveCallHeaderControls: View {
	let session: LiveMeetingSession
	let onEnd: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s3) {
				Circle().fill(MaskinColor.danger).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				CallTimer(session: session)
			}
			.padding(.horizontal, MaskinSpace.s6)
			.frame(height: MaskinSpace.s14 + MaskinSpace.s2)
			.background(MaskinColor.sigTint, in: Capsule())
			.accessibilityElement(children: .combine)
			.accessibilityLabel("Call running")
			Button {
				MaskinHaptics.play(.medium)
				onEnd()
			} label: {
				Image(systemName: "phone.down.fill")
					.maskinSymbol(16, weight: .semibold)
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
					.background(Circle().fill(MaskinColor.danger))
					.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("End call")
		}
	}
}
