import ActivityKit
import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// The opt-in "Following an agent" card (v3 design; it replaces the automatic Agents card). The
/// person starts it with Follow on an agent's working banner. It shows who, what the work is
/// about, the elapsed time and the latest step, with Open and Stop following. A session has no
/// known finish, so there is no progress bar. When the agent finishes the same card reads
/// "<Agent> finished" with Review, and goes after fifteen minutes. Patina is signal only; actions
/// are ink; done is an ink check, never green.
struct FollowLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinFollowAttributes.self) { context in
			FollowLockScreenView(attributes: context.attributes, state: context.state)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s7)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(context.attributes.openURL)
		} dynamicIsland: { context in
			let state = context.state
			let attributes = context.attributes
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					LiveActivityAgentTile(name: state.agentName, size: MaskinSpace.s14)
						.padding(.top, MaskinSpace.s2)
				}
				DynamicIslandExpandedRegion(.center) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(state.isFinished ? "FINISHED" : "FOLLOWING")
							.maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk).lineLimit(1)
						Text(state.isFinished ? state.finishedTitle : state.title)
							.maskinText(.headline).lineLimit(1)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
				DynamicIslandExpandedRegion(.trailing) {
					if !state.isFinished { FollowElapsed(state: state).maskinText(.subhead) }
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						if !state.isFinished {
							Text(state.nowLine).maskinText(.subhead).foregroundStyle(MaskinColor.ink3).lineLimit(1)
						}
						FollowActions(attributes: attributes, state: state)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				if state.isFinished {
					FollowDoneMark()
				} else {
					LiveActivityAgentTile(name: state.agentName, size: MaskinSpace.s12)
				}
			} compactTrailing: {
				if !state.isFinished { FollowElapsed(state: state).maskinText(.mono).frame(maxWidth: 52) }
			} minimal: {
				if state.isFinished {
					FollowDoneMark()
				} else {
					LiveActivityAgentTile(name: state.agentName, size: MaskinSpace.s12)
				}
			}
			.widgetURL(attributes.openURL)
			.keylineTint(MaskinColor.sig)
		}
	}
}

/// Elapsed time, counted by the system from `startedAt`.
private struct FollowElapsed: View {
	let state: FollowActivityState

	var body: some View {
		Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
			.monospacedDigit()
			.multilineTextAlignment(.trailing)
			.foregroundStyle(MaskinColor.ink4)
	}
}

/// Finished: an ink check, as on the other done states.
private struct FollowDoneMark: View {
	var body: some View {
		Image(systemName: "checkmark")
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink)
			.accessibilityLabel("Finished")
	}
}

private struct FollowLockScreenView: View {
	let attributes: MaskinFollowAttributes
	let state: FollowActivityState

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(alignment: .center, spacing: MaskinSpace.s5) {
				if state.isFinished {
					FollowDoneMark().font(.title3).frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
				} else {
					LiveActivityAgentTile(name: state.agentName, size: MaskinSpace.s14)
				}
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(state.isFinished ? "FINISHED" : "FOLLOWING")
						.maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk).lineLimit(1)
					Text(state.isFinished ? state.finishedTitle : state.title)
						.maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s3)
				if !state.isFinished { FollowElapsed(state: state).maskinText(.subhead) }
			}
			.accessibilityElement(children: .combine)
			if !state.isFinished {
				Text(state.nowLine).maskinText(.subhead).foregroundStyle(MaskinColor.ink3).lineLimit(1)
			}
			FollowActions(attributes: attributes, state: state, compact: true)
		}
		// iOS crops the card rather than growing it.
		.dynamicTypeSize(...DynamicTypeSize.large)
		.accessibilityElement(children: .contain)
	}
}

/// Following: Open (ink) and Stop following (quiet). Finished: Review (ink).
private struct FollowActions: View {
	let attributes: MaskinFollowAttributes
	let state: FollowActivityState
	var compact = false

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			if state.isFinished {
				Link(destination: attributes.openURL) { FollowLabel("Review", compact: compact) }
			} else {
				Link(destination: attributes.openURL) { FollowLabel("Open", compact: compact) }
				Button(intent: StopFollowingIntent(sessionId: attributes.target.sessionId)) {
					FollowLabel("Stop following", quiet: true, compact: compact)
				}
				.buttonStyle(.plain)
			}
		}
	}
}

private struct FollowLabel: View {
	let text: String
	let quiet: Bool
	let compact: Bool
	init(_ text: String, quiet: Bool = false, compact: Bool = false) {
		self.text = text
		self.quiet = quiet
		self.compact = compact
	}

	var body: some View {
		Text(text)
			.maskinText(.caption)
			.lineLimit(1)
			.foregroundStyle(quiet ? MaskinColor.ink3 : MaskinSurface.onInverse)
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: compact ? MaskinSpace.s14 : MaskinSpace.touchMin)
			.background(quiet ? MaskinSurface.fill : MaskinSurface.inverse, in: Capsule())
	}
}
