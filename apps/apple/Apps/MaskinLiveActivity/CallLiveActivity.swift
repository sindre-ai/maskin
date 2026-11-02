import ActivityKit
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// A live voice call with an agent, as one slim pill like a system call card: the call orb, the
/// agent's name over a system-driven timer, and two round buttons, Mute and End. There is no status
/// text; what the call is doing shows in the orb's tint and the mute glyph (the words live in the
/// accessibility label). Both buttons are Live Activity intents that act on the call itself
/// (`LiveCallControl`), so they work from the Lock Screen without opening the app.
struct CallLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: LiveCallActivityAttributes.self) { context in
			CallPill(name: context.attributes.agentName, state: context.state)
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.vertical, MaskinSpace.s4)
				.activityBackgroundTint(MaskinSurface.card.opacity(0.55))
				.widgetURL(context.attributes.openURL)
		} dynamicIsland: { context in
			let name = context.attributes.agentName
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					CallOrb(phase: state.phase, size: 36)
				}
				DynamicIslandExpandedRegion(.center) {
					NameAndTimer(name: name, state: state)
				}
				DynamicIslandExpandedRegion(.bottom) {
					CallButtons(isMuted: state.isMuted)
				}
			} compactLeading: {
				CallOrb(phase: state.phase, size: 20)
			} compactTrailing: {
				CallTimer(startedAt: state.startedAt).maskinText(.mono).frame(maxWidth: 48)
			} minimal: {
				CallOrb(phase: state.phase, size: 20)
			}
			.widgetURL(context.attributes.openURL)
			.keylineTint(MaskinColor.sig)
		}
	}
}

/// A static orb in the brand's Patina: widgets can't animate, so state is tint and opacity only.
private struct CallOrb: View {
	let phase: LiveCallActivityState.Phase
	var size: CGFloat = 36

	var body: some View {
		Circle()
			.fill(
				RadialGradient(
					colors: [MaskinColor.sigHi, MaskinColor.sig], center: .topLeading, startRadius: 0,
					endRadius: size))
			.frame(width: size, height: size)
			.opacity(opacity)
			.accessibilityHidden(true)
	}

	/// Speaking is full; listening and thinking sit back; muted and the connection states are dim.
	private var opacity: Double {
		switch phase {
		case .speaking: 1
		case .listening, .thinking: 0.8
		case .muted, .connecting, .reconnecting: 0.4
		}
	}
}

private struct CallTimer: View {
	let startedAt: Date
	var body: some View {
		Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
			.monospacedDigit()
			.multilineTextAlignment(.leading)
			.foregroundStyle(MaskinColor.ink4)
	}
}

private struct NameAndTimer: View {
	let name: String
	let state: LiveCallActivityState

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text(name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
			CallTimer(startedAt: state.startedAt).maskinText(.caption)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(name), \(state.statusText)")
	}
}

private struct CallPill: View {
	let name: String
	let state: LiveCallActivityState

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			CallOrb(phase: state.phase, size: 36)
			NameAndTimer(name: name, state: state)
			Spacer(minLength: MaskinSpace.s4)
			CallButtons(isMuted: state.isMuted)
		}
	}
}

/// Mute (a slashed mic while muted) and End (an X): two round 44pt buttons.
private struct CallButtons: View {
	let isMuted: Bool

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			Button(intent: ToggleCallMuteIntent()) { glyph(isMuted ? "mic.slash.fill" : "mic.fill") }
				.buttonStyle(.plain)
				.accessibilityLabel(isMuted ? "Unmute" : "Mute")
			Button(intent: EndCallIntent()) { glyph("xmark") }
				.buttonStyle(.plain)
				.accessibilityLabel("End call")
		}
	}

	private func glyph(_ name: String) -> some View {
		Image(systemName: name)
			.maskinSymbol(MaskinFontSize.t17, weight: .semibold)
			.foregroundStyle(MaskinColor.ink)
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			.background(MaskinColor.ink.opacity(0.12), in: Circle())
	}
}

#if DEBUG
	private extension LiveCallActivityAttributes {
		static var preview: LiveCallActivityAttributes {
			LiveCallActivityAttributes(callId: "preview", agentName: "Relay", workspaceId: "ws", conversationId: nil)
		}
	}

	private extension LiveCallActivityState {
		static func preview(_ phase: Phase, muted: Bool = false) -> LiveCallActivityState {
			.init(phase: phase, isMuted: muted, startedAt: Date().addingTimeInterval(-754))
		}
	}

	#Preview("Lock Screen", as: .content, using: LiveCallActivityAttributes.preview) {
		CallLiveActivity()
	} contentStates: {
		LiveCallActivityState.preview(.connecting)
		LiveCallActivityState.preview(.listening)
		LiveCallActivityState.preview(.speaking)
		LiveCallActivityState.preview(.thinking)
		LiveCallActivityState.preview(.muted, muted: true)
		LiveCallActivityState.preview(.reconnecting, muted: true)
	}

	#Preview("Island expanded", as: .dynamicIsland(.expanded), using: LiveCallActivityAttributes.preview) {
		CallLiveActivity()
	} contentStates: {
		LiveCallActivityState.preview(.listening)
		LiveCallActivityState.preview(.muted, muted: true)
	}

	#Preview("Island compact", as: .dynamicIsland(.compact), using: LiveCallActivityAttributes.preview) {
		CallLiveActivity()
	} contentStates: {
		LiveCallActivityState.preview(.speaking)
	}

	#Preview("Island minimal", as: .dynamicIsland(.minimal), using: LiveCallActivityAttributes.preview) {
		CallLiveActivity()
	} contentStates: {
		LiveCallActivityState.preview(.listening)
		LiveCallActivityState.preview(.muted, muted: true)
	}
#endif
