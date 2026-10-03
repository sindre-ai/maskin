import ActivityKit
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// Lock screen and Dynamic Island for a running agent: who, what, and how long. Tapping opens
/// the app. The elapsed time is a system timer, so it keeps counting without updates.
struct SessionLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: SessionActivityAttributes.self) { context in
			LockScreenActivityView(info: context.attributes.info, state: context.state)
				.activityBackgroundTint(MaskinSurface.card)
		} dynamicIsland: { context in
			let info = context.attributes.info
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					BrandGlyph(size: 24).padding(.leading, 4)
				}
				DynamicIslandExpandedRegion(.trailing) {
					ElapsedText(since: info.startedAt, phase: context.state.phase)
						.font(.system(.callout, design: .monospaced))
				}
				DynamicIslandExpandedRegion(.center) {
					Text(info.agentName).font(.headline).lineLimit(1)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: 2) {
						Text(info.task).font(.subheadline).lineLimit(2)
						Text(context.state.step ?? context.state.phase.label)
							.font(.caption).foregroundStyle(.secondary).lineLimit(1)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				BrandGlyph(size: 18)
			} compactTrailing: {
				ElapsedText(since: info.startedAt, phase: context.state.phase)
					.font(.system(.caption2, design: .monospaced))
					.frame(maxWidth: 48)
			} minimal: {
				BrandGlyph(size: 18)
			}
		}
	}
}

private struct LockScreenActivityView: View {
	let info: SessionActivityInfo
	let state: SessionActivityState

	var body: some View {
		HStack(alignment: .center, spacing: 12) {
			BrandGlyph(size: 36)
			VStack(alignment: .leading, spacing: 2) {
				Text(info.agentName).font(.headline).lineLimit(1)
				Text(info.task).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
				Text(state.step ?? state.phase.label).font(.caption).lineLimit(1)
					.foregroundStyle(state.phase == .needsYou ? MaskinColor.accent : .secondary)
			}
			Spacer(minLength: 0)
			ElapsedText(since: info.startedAt, phase: state.phase)
				.font(.system(.title3, design: .monospaced))
		}
		.padding(16)
		.accessibilityElement(children: .combine)
	}
}

/// A live-counting timer while the run is going, nothing once it has finished.
private struct ElapsedText: View {
	let since: Date
	let phase: SessionActivityPhase

	var body: some View {
		if phase.isFinal {
			Text(phase.label)
		} else {
			Text(timerInterval: since...Date.distantFuture, countsDown: false)
				.monospacedDigit().multilineTextAlignment(.trailing)
		}
	}
}
