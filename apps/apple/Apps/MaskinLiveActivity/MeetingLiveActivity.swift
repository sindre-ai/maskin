import ActivityKit
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// A live meeting with Chief of Staff or an agent: "LIVE · AD HOC MEETING", the name and a running
/// timer. Dynamic Island compact is the avatar and the timer; expanded adds Open. There is no
/// meeting model or backend call in the app yet, so End (which must also hang up) is not offered
/// here: a button that only removed the card would leave the call running.
struct MeetingLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinMeetingAttributes.self) { context in
			MeetingLockScreenView(state: context.state)
				.padding(MaskinSpace.s9)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(context.attributes.openURL)
		} dynamicIsland: { context in
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					LiveActivityAgentTile(name: state.name, size: 32)
				}
				DynamicIslandExpandedRegion(.center) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text("LIVE MEETING").maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk)
						Text(state.name).maskinText(.headline).lineLimit(1)
					}
				}
				DynamicIslandExpandedRegion(.trailing) {
					MeetingTimer(state: state).font(MaskinTypeface.mono(MaskinFontSize.t20, weight: .semibold, relativeTo: .title3))
				}
				DynamicIslandExpandedRegion(.bottom) {
					Link(destination: context.attributes.openURL) {
						Label("Open", systemImage: "arrow.up.right").maskinText(.caption)
					}
					.tint(MaskinColor.ink)
				}
			} compactLeading: {
				LiveActivityAgentTile(name: state.name, size: 20)
			} compactTrailing: {
				MeetingTimer(state: state).font(MaskinTypeface.mono(MaskinFontSize.t14, weight: .semibold, relativeTo: .footnote)).frame(maxWidth: 52)
			} minimal: {
				LiveActivityAgentTile(name: state.name, size: 20)
			}
			.widgetURL(context.attributes.openURL)
			.keylineTint(MaskinColor.sig)
		}
	}
}

private struct MeetingTimer: View {
	let state: MeetingActivityState
	var body: some View {
		Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
			.monospacedDigit()
			.multilineTextAlignment(.trailing)
			.foregroundStyle(MaskinColor.ink4)
	}
}

private struct MeetingLockScreenView: View {
	let state: MeetingActivityState

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			HStack(spacing: MaskinSpace.s7) {
				LiveActivityAgentTile(name: state.name, size: 44)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(state.kind.eyebrow).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					Text(state.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s4)
				MeetingTimer(state: state).font(MaskinTypeface.mono(MaskinFontSize.t20, weight: .semibold, relativeTo: .title3))
			}
			// Mute and End sit beside the bars in the mockup. Both need a meeting model and a
			// hang-up call that do not exist yet, so only the bars are drawn.
			LiveActivityLevelBars(muted: state.muted)
		}
		.accessibilityElement(children: .combine)
	}
}
