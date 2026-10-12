import ActivityKit
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// The one aggregate "Agents working" activity (handoff 8). One agent: avatar and level bars
/// compact; "Forge is rolling out Retry policy v2", a bar and Open expanded. Several: up to three
/// stacked avatars and the count compact; the headline, the three rows closest to finishing and
/// See all expanded. Decisions waiting on the reader are never here (notifications and widgets).
/// Pause rollout / Pause all are not offered: pausing needs the app process and the sessions
/// endpoint, and a button that only removed the card would leave the agents running.
struct AgentsWorkingLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinAgentsWorkingAttributes.self) { context in
			AgentsWorkingLockScreenView(state: context.state)
				.padding(MaskinSpace.s9)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(context.attributes.openURL)
		} dynamicIsland: { context in
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					AgentStack(agents: state.compactAvatars, size: 28)
				}
				DynamicIslandExpandedRegion(.center) {
					Text(state.headline).maskinText(.headline).lineLimit(2)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						AgentRows(state: state)
						Link(destination: context.attributes.openURL) {
							Label(
								state.layout == .many ? "See all \(state.total)" : "Open",
								systemImage: "arrow.up.right"
							)
							.maskinText(.caption)
						}
						.tint(MaskinColor.ink)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				AgentStack(agents: state.compactAvatars, size: 20)
			} compactTrailing: {
				HStack(spacing: MaskinSpace.s2) {
					if let count = state.compactCount {
						Text(count).maskinText(.mono).monospacedDigit()
					}
					LevelBars()
				}
			} minimal: {
				LevelBars()
			}
			.widgetURL(context.attributes.openURL)
			.keylineTint(MaskinColor.sig)
		}
	}
}

/// Three level bars: agents are working.
private struct LevelBars: View {
	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s1) {
			ForEach([5.0, 11.0, 7.0], id: \.self) { height in
				RoundedRectangle(cornerRadius: 1)
					.fill(MaskinColor.sigInk)
					.frame(width: MaskinSpace.s1, height: height)
			}
		}
		.frame(height: 11)
		.accessibilityHidden(true)
	}
}

/// Up to three overlapping avatars.
private struct AgentStack: View {
	let agents: [WorkingAgent]
	var size: CGFloat

	var body: some View {
		HStack(spacing: -size * 0.3) {
			ForEach(agents) { agent in
				LiveActivityAgentTile(name: agent.name, size: size)
					.overlay(
						RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
							.stroke(MaskinSurface.card, lineWidth: 1.5))
			}
		}
		.accessibilityHidden(true)
	}
}

/// The agents' lines: one sentence and a bar for a single agent, three ranked rows for several.
private struct AgentRows: View {
	let state: AgentsWorkingState

	var body: some View {
		switch state.layout {
		case .single:
			if let agent = state.rows.first {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					if !agent.etaLabel.isEmpty {
						Text("\(agent.etaLabel) left").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
					}
					ProgressView().progressViewStyle(.linear).tint(MaskinColor.sig)
				}
			}
		case .many:
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				ForEach(state.rows) { agent in
					HStack(spacing: MaskinSpace.s4) {
						LiveActivityAgentTile(name: agent.name, size: 20)
						Text(agent.sentence).maskinText(.caption).lineLimit(1)
						Spacer(minLength: MaskinSpace.s3)
						Text(agent.etaLabel).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
					.accessibilityElement(children: .combine)
				}
			}
		}
	}
}

private struct AgentsWorkingLockScreenView: View {
	let state: AgentsWorkingState

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s5) {
				AgentStack(agents: state.compactAvatars, size: 32)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text("AGENTS WORKING").maskinText(.microLabel).foregroundStyle(MaskinColor.sigInk)
					Text(state.headline).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(2)
				}
				Spacer(minLength: MaskinSpace.s4)
				LevelBars()
			}
			AgentRows(state: state)
		}
		.accessibilityElement(children: .combine)
	}
}
