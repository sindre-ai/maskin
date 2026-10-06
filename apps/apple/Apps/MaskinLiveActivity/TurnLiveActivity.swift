import ActivityKit
import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// Lock Screen banner and Dynamic Island for a running agent turn. Tapping anywhere opens the
/// thread (`widgetURL`, a `maskin://` link the app's `DeepLinkRouter` validates); a running turn
/// also offers Stop via `StopTurnIntent`.
struct TurnLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinTurnAttributes.self) { context in
			LockScreenTurnView(attributes: context.attributes, state: context.state)
				.padding(MaskinSpace.s9)
				.activityBackgroundTint(nil)
				.widgetURL(context.attributes.identity.openURL)
		} dynamicIsland: { context in
			let attributes = context.attributes
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					StatusGlyph(status: state.status).font(.title3)
				}
				DynamicIslandExpandedRegion(.trailing) {
					ElapsedLabel(state: state).font(.callout)
				}
				DynamicIslandExpandedRegion(.center) {
					Text(state.agentName).font(.headline).lineLimit(1)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						Text(state.step).font(.subheadline).lineLimit(2)
						TurnActions(attributes: attributes, state: state)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				StatusGlyph(status: state.status)
			} compactTrailing: {
				ElapsedLabel(state: state).frame(maxWidth: 48)
			} minimal: {
				StatusGlyph(status: state.status)
			}
			.widgetURL(attributes.identity.openURL)
			.keylineTint(StatusStyle.tint(state.status))
		}
	}
}

/// Colour and symbol per status, kept together so every surface agrees.
enum StatusStyle {
	static func tint(_ status: TurnActivityStatus) -> Color {
		switch status {
		case .running: MaskinColor.accent
		case .needsYou: MaskinColor.warning
		case .done: MaskinColor.success
		case .failed: MaskinColor.danger
		}
	}

	static func symbol(_ status: TurnActivityStatus) -> String {
		switch status {
		case .running: "sparkles"
		case .needsYou: "exclamationmark.bubble.fill"
		case .done: "checkmark.circle.fill"
		case .failed: "xmark.octagon.fill"
		}
	}

	static func label(_ status: TurnActivityStatus) -> String {
		switch status {
		case .running: "Working"
		case .needsYou: "Needs you"
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
				.foregroundStyle(.secondary)
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
				Label("Stop", systemImage: "stop.fill").font(.footnote.weight(.semibold))
			}
			.buttonStyle(.bordered)
			.tint(MaskinColor.danger)
		case .needsYou:
			// Tapping the card opens the thread; this is the same destination, spelled out.
			Link(destination: attributes.identity.openURL) {
				Label("Open thread", systemImage: "arrow.up.right").font(.footnote.weight(.semibold))
			}
			.tint(MaskinColor.warning)
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
			HStack(spacing: MaskinSpace.s4) {
				StatusGlyph(status: state.status)
				Text(state.agentName).font(.headline).lineLimit(1)
				Spacer(minLength: MaskinSpace.s4)
				ElapsedLabel(state: state).font(.subheadline)
			}
			Text(state.step)
				.font(.subheadline)
				.foregroundStyle(.secondary)
				.lineLimit(2)
			TurnActions(attributes: attributes, state: state)
		}
		.accessibilityElement(children: .combine)
	}
}
