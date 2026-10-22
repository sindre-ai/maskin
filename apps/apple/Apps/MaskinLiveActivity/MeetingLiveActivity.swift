import ActivityKit
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// A live meeting with Chief of Staff or an agent: "LIVE · AD HOC MEETING", the name and a running
/// timer. Dynamic Island compact is the avatar and the timer; expanded adds Mute, Open and End.
/// Mute and End are Live Activity intents that act on the live call itself (`MeetingCallControl`),
/// so End hangs up rather than only removing the card. There are no level bars: the call exposes
/// no microphone level to the activity.
struct MeetingLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinMeetingAttributes.self) { context in
			MeetingLockScreenView(state: context.state, openURL: context.attributes.openURL)
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
						Text("LIVE MEETING").maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
						Text(state.name).maskinText(.headline).lineLimit(1)
					}
				}
				DynamicIslandExpandedRegion(.trailing) {
					MeetingTimer(state: state).maskinText(.subhead)
				}
				DynamicIslandExpandedRegion(.bottom) {
					MeetingActions(state: state, openURL: context.attributes.openURL)
				}
			} compactLeading: {
				LiveActivityAgentTile(name: state.name, size: 20)
			} compactTrailing: {
				MeetingTimer(state: state).maskinText(.mono).frame(maxWidth: 48)
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
	let openURL: URL

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			HStack(spacing: MaskinSpace.s7) {
				LiveActivityAgentTile(name: state.name, size: 44)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(state.kind.eyebrow).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					Text(state.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s4)
				MeetingTimer(state: state)
					.font(MaskinTypeface.mono(MaskinFontSize.t20, weight: .semibold, relativeTo: .title3))
					.foregroundStyle(MaskinColor.ink)
			}
			.accessibilityElement(children: .combine)
			// The mockup's lock screen is one row: level bars, an icon-only mic circle, a red End.
			HStack(spacing: MaskinSpace.s4) {
				LiveActivityLevelBars(muted: state.muted)
				Spacer(minLength: MaskinSpace.s4)
				Button(intent: ToggleMeetingMuteIntent()) {
					Image(systemName: state.muted ? "mic.slash.fill" : "mic.fill")
						.maskinSymbol(MaskinFontSize.t17, weight: .semibold)
						.foregroundStyle(MaskinColor.ink3)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.background(MaskinSurface.fill, in: Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel(state.muted ? "Unmute" : "Mute")
				Button(intent: EndMeetingIntent()) {
					Text("End")
						.maskinText(.caption)
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(minHeight: MaskinSpace.touchMin)
						.background(MaskinColor.danger, in: Capsule())
				}
				.buttonStyle(.plain)
			}
		}
	}
}

/// Mute and End act on the live call; Open goes to its chat. Each is 44pt tall.
private struct MeetingActions: View {
	let state: MeetingActivityState
	let openURL: URL

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			Button(intent: ToggleMeetingMuteIntent()) {
				Label(state.muted ? "Unmute" : "Mute", systemImage: state.muted ? "mic.slash.fill" : "mic.fill")
					.labelStyle(.titleAndIcon)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin)
					.background(MaskinSurface.fill, in: Capsule())
			}
			.buttonStyle(.plain)
			Link(destination: openURL) {
				Text("Open")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin)
					.background(MaskinSurface.fill, in: Capsule())
			}
			Button(intent: EndMeetingIntent()) {
				Text("End")
					.maskinText(.caption)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin)
					.background(MaskinColor.danger, in: Capsule())
			}
			.buttonStyle(.plain)
		}
	}
}
