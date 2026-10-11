import ActivityKit
import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// Lock Screen banner and Dynamic Island for a running agent turn. Tapping anywhere opens the
/// thread (`widgetURL`, a `maskin://` link the app's `DeepLinkRouter` validates); a running turn
/// also offers Stop via `StopTurnIntent`.
///
/// A Live Activity is for time-bound work only: a decision waiting on the reader is a widget and a
/// notification. So the only live state is "working"; every other state is a finished card that
/// lingers and ends.
struct TurnLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinTurnAttributes.self) { context in
			LockScreenTurnView(attributes: context.attributes, state: context.state)
				.padding(MaskinSpace.s9)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(context.attributes.identity.openURL)
		} dynamicIsland: { context in
			let attributes = context.attributes
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					LiveActivityAgentTile(name: state.agentName, size: 32)
				}
				DynamicIslandExpandedRegion(.trailing) {
					ElapsedLabel(state: state).maskinText(.subhead)
				}
				DynamicIslandExpandedRegion(.center) {
					Text(state.agentName).maskinText(.headline).lineLimit(1)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						Text(state.step).maskinText(.subhead).lineLimit(2)
						TurnActions(attributes: attributes, state: state)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				LiveActivityMarkTile(size: 20)
			} compactTrailing: {
				ElapsedLabel(state: state).maskinText(.mono).frame(maxWidth: 48)
			} minimal: {
				StatusGlyph(status: state.status)
			}
			.widgetURL(attributes.identity.openURL)
			.keylineTint(StatusStyle.tint(state.status))
		}
	}
}

/// Colour and symbol per status, kept together so every surface agrees. Brand rules: Patina is a
/// signal, so only the live "working" state carries it; done and the rest are ink.
enum StatusStyle {
	static func tint(_ status: TurnActivityStatus) -> Color {
		switch status {
		case .running: MaskinColor.sig
		case .needsYou, .done, .failed: MaskinColor.ink
		}
	}

	static func symbol(_ status: TurnActivityStatus) -> String {
		switch status {
		case .running: "sparkles"
		case .needsYou: "bubble.left"
		case .done: "checkmark.circle.fill"
		case .failed: "xmark.circle"
		}
	}

	static func label(_ status: TurnActivityStatus) -> String {
		switch status {
		case .running: "Working"
		case .needsYou: "Waiting on you"
		case .done: "Done"
		case .failed: "Failed"
		}
	}
}

private struct StatusGlyph: View {
	let status: TurnActivityStatus
	var body: some View {
		Image(systemName: StatusStyle.symbol(status))
			.foregroundStyle(StatusStyle.tint(status))
			.accessibilityLabel(StatusStyle.label(status))
	}
}

/// A live-ticking elapsed timer while the turn is going; nothing once it has finished (a frozen
/// number would read as still running).
private struct ElapsedLabel: View {
	let state: TurnActivityState
	var body: some View {
		if state.status.isTerminal {
			EmptyView()
		} else {
			Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
				.monospacedDigit()
				.multilineTextAlignment(.trailing)
				.foregroundStyle(MaskinColor.ink4)
		}
	}
}

private struct TurnActions: View {
	let attributes: MaskinTurnAttributes
	let state: TurnActivityState

	var body: some View {
		switch state.status {
		case .running:
			Button(intent: StopTurnIntent(sessionId: attributes.sessionId, workspaceId: attributes.workspaceId)) {
				Label("Stop", systemImage: "stop.fill").maskinText(.caption)
			}
			.buttonStyle(.bordered)
			.tint(MaskinColor.ink)
		case .needsYou:
			// The ask itself is a notification; this just points at the thread.
			Link(destination: attributes.identity.openURL) {
				Label("Open thread", systemImage: "arrow.up.right").maskinText(.caption)
			}
			.tint(MaskinColor.ink)
		case .done, .failed:
			EmptyView()
		}
	}
}

private struct LockScreenTurnView: View {
	let attributes: MaskinTurnAttributes
	let state: TurnActivityState

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			// Brand header: the mark and "MASKIN . LIVE", with the elapsed time at the trailing edge.
			HStack(spacing: MaskinSpace.s4) {
				LiveActivityMarkTile(size: 22)
				Text("MASKIN \u{00B7} LIVE")
					.maskinText(.microLabel)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: MaskinSpace.s4)
				StatusGlyph(status: state.status).maskinText(.caption)
				ElapsedLabel(state: state).maskinText(.caption)
			}
			// No progress bar: nothing in the turn reports a percentage.
			HStack(spacing: MaskinSpace.s5) {
				LiveActivityAgentTile(name: state.agentName, size: 44)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(state.agentName).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Text(state.step)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(2)
				}
			}
			TurnActions(attributes: attributes, state: state)
		}
		.accessibilityElement(children: .combine)
	}
}
