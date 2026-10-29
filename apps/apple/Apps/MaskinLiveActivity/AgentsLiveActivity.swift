import ActivityKit
import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI
import WidgetKit

/// Lock Screen card and Dynamic Island for the one "Agents working" activity. One agent: avatar,
/// "Forge is rolling out Retry policy v2", a progress line and Pause · Open. Several: stacked
/// avatars, "23 agents working · 3 finish in 15 min", the three closest to finishing and
/// Pause all · See all 23. Patina is signal only (the level bars, the working ring); actions
/// are ink; a finished card is ink ✓. Decisions never appear here.
struct AgentsLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: MaskinAgentsAttributes.self) { context in
			LockScreenAgentsView(identity: context.attributes.identity, state: context.state)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s7)
				.activityBackgroundTint(MaskinSurface.card)
				.widgetURL(tapURL(context.attributes.identity, context.state))
		} dynamicIsland: { context in
			let identity = context.attributes.identity
			let state = context.state
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					AvatarStack(agents: state.agents, size: MaskinSpace.s14)
						.padding(.top, MaskinSpace.s2)
				}
				DynamicIslandExpandedRegion(.trailing) {
					if state.count == 1, let agent = state.agents.first {
						TimeLabel(agent: agent).maskinText(.subhead)
					} else if !state.isEmpty {
						LevelBars()
					}
				}
				DynamicIslandExpandedRegion(.center) {
					Headline(state: state)
				}
				DynamicIslandExpandedRegion(.bottom) {
					VStack(alignment: .leading, spacing: MaskinSpace.s5) {
						AgentsBody(state: state)
						AgentsActions(identity: identity, state: state)
					}
					.frame(maxWidth: .infinity, alignment: .leading)
				}
			} compactLeading: {
				if state.isEmpty {
					DoneMark()
				} else {
					AvatarStack(agents: state.agents, size: MaskinSpace.s12)
				}
			} compactTrailing: {
				if state.isEmpty {
					EmptyView()
				} else {
					HStack(spacing: MaskinSpace.s3) {
						if state.count > 1 {
							Text(verbatim: "\(state.count)")
								.maskinText(.mono)
								.monospacedDigit()
						}
						LevelBars()
					}
				}
			} minimal: {
				if state.isEmpty {
					DoneMark()
				} else if state.count == 1, let agent = state.agents.first {
					AvatarTile(agent: agent, size: MaskinSpace.s12)
				} else {
					Text(verbatim: "\(state.count)")
						.maskinText(.mono)
						.monospacedDigit()
				}
			}
			.widgetURL(tapURL(identity, state))
			.keylineTint(MaskinColor.sig)
		}
	}

	/// Tapping the card: one agent opens its thing, several open the Agents screen.
	private func tapURL(_ identity: AgentsActivityIdentity, _ state: AgentsActivityState) -> URL {
		if state.count == 1, let agent = state.agents.first { return agent.openURL(workspaceId: identity.workspaceId) }
		return identity.seeAllURL
	}
}

// MARK: - Pieces

/// The agent's tile (`LiveActivityAgentTile`: first letter on the signal tint, the logo tile for
/// the platform agent), with a thin signal ring while it works.
private struct AvatarTile: View {
	let agent: WorkingAgent
	let size: CGFloat
	var ring = true

	var body: some View {
		LiveActivityAgentTile(name: agent.name, size: size)
			.overlay {
				if ring {
					RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
						.strokeBorder(MaskinColor.sig, lineWidth: 1.5)
				}
			}
			.accessibilityLabel("\(agent.name), working")
	}
}

/// Up to three avatars overlapping leftwards, the way the prototype stacks them.
private struct AvatarStack: View {
	let agents: [WorkingAgent]
	let size: CGFloat

	var body: some View {
		let shown = Array(agents.prefix(3))
		HStack(spacing: -size * 0.3) {
			ForEach(Array(shown.enumerated()), id: \.element.id) { index, agent in
				AvatarTile(agent: agent, size: size, ring: shown.count == 1)
					// A hairline in the tile's own ink keeps overlapping tiles readable on any background.
					.overlay(
						RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
							.strokeBorder(MaskinColor.sigInk.opacity(0.25), lineWidth: shown.count > 1 ? 1 : 0))
					.zIndex(Double(shown.count - index))
			}
		}
		.accessibilityElement(children: .combine)
	}
}

/// Three Patina level bars: the "working" glyph. A Live Activity is rendered by the system from
/// snapshots, so the prototype's 0.8 s loop cannot run here; the bars are drawn at three
/// heights and the system animates between snapshots as the state changes. Reduce Motion
/// therefore changes nothing: nothing moves on its own.
private struct LevelBars: View {
	var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s1) {
			ForEach([0.45, 1.0, 0.7], id: \.self) { height in
				Capsule().fill(MaskinColor.sig)
					.frame(width: MaskinSpace.s2, height: MaskinSpace.s8 * height)
			}
		}
		.frame(height: MaskinSpace.s8, alignment: .bottom)
		.accessibilityLabel("Working")
	}
}

/// Finished: ink ✓, never green.
private struct DoneMark: View {
	var body: some View {
		Image(systemName: "checkmark")
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink)
			.accessibilityLabel("Agents finished")
	}
}

private struct Headline: View {
	let state: AgentsActivityState
	var body: some View {
		Text(state.headline(now: Date()))
			.maskinText(.headline)
			.lineLimit(2)
			.multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// Time left when a finish is known; a live elapsed timer otherwise.
private struct TimeLabel: View {
	let agent: WorkingAgent
	var body: some View {
		if let left = agent.timeLeftText(now: Date()) {
			Text(left).foregroundStyle(MaskinColor.ink4)
		} else {
			Text(timerInterval: agent.startedAt...Date.distantFuture, countsDown: false)
				.monospacedDigit()
				.multilineTextAlignment(.trailing)
				.foregroundStyle(MaskinColor.ink4)
		}
	}
}

/// Below the headline: one agent gets a progress line and a bar; several get the three rows
/// closest to finishing; none gets the finished line.
private struct AgentsBody: View {
	let state: AgentsActivityState
	/// The Lock Screen card gets about 160 pt in all, so its rows run tighter than the island's.
	var compact = false

	var body: some View {
		switch state.count {
		case 0:
			Text("Everything that was running is done.")
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
		case 1:
			if let agent = state.agents.first {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					Text(progressLine(agent))
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(1)
					ProgressBar(agent: agent)
				}
			}
		default:
			VStack(alignment: .leading, spacing: compact ? MaskinSpace.s1 : MaskinSpace.s3) {
				ForEach(state.top) { agent in AgentRow(agent: agent, compact: compact) }
			}
		}
	}

	private func progressLine(_ agent: WorkingAgent) -> String {
		var parts = ["Started \(started(agent))"]
		if let left = agent.timeLeftText(now: Date()) { parts.append(left) }
		if let topic = agent.topic { parts.append(topic) }
		return parts.joined(separator: " · ")
	}

	private func started(_ agent: WorkingAgent) -> String {
		agent.startedAt.formatted(.relative(presentation: .named))
	}
}

/// Patina progress: real progress when a finish is known, an indeterminate third otherwise.
private struct ProgressBar: View {
	let agent: WorkingAgent

	var body: some View {
		let fraction = fraction(now: Date())
		GeometryReader { proxy in
			ZStack(alignment: .leading) {
				Capsule().fill(MaskinSurface.fill)
				Capsule().fill(MaskinColor.sig).frame(width: max(MaskinSpace.s4, proxy.size.width * fraction))
			}
		}
		.frame(height: MaskinSpace.s2)
		.accessibilityLabel(agent.expectedFinishAt == nil ? "In progress" : "\(Int(fraction * 100)) percent")
	}

	private func fraction(now: Date) -> CGFloat {
		guard let finish = agent.expectedFinishAt else { return 0.33 }
		let total = finish.timeIntervalSince(agent.startedAt)
		guard total > 0 else { return 1 }
		return CGFloat(min(1, max(0.02, now.timeIntervalSince(agent.startedAt) / total)))
	}
}

private struct AgentRow: View {
	let agent: WorkingAgent
	var compact = false
	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			AvatarTile(agent: agent, size: compact ? MaskinSpace.s11 : MaskinSpace.s12, ring: false)
			Text(agent.sentence)
				.maskinText(.subhead)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s3)
			TimeLabel(agent: agent)
				.maskinText(.caption)
				.lineLimit(1)
		}
	}
}

/// Ink actions. Pause runs `PauseAgentsIntent` in the app process; Open and See all are deep
/// links the app's router validates.
private struct AgentsActions: View {
	let identity: AgentsActivityIdentity
	let state: AgentsActivityState
	var compact = false

	var body: some View {
		if state.isEmpty {
			EmptyView()
		} else {
			HStack(spacing: MaskinSpace.s4) {
				Button(
					intent: PauseAgentsIntent(sessionIds: state.agents.map(\.sessionId), workspaceId: identity.workspaceId)
				) {
					InkLabel(state.pauseLabel, quiet: true, compact: compact)
				}
				.buttonStyle(.plain)
				if state.count == 1, let agent = state.agents.first {
					Link(destination: agent.openURL(workspaceId: identity.workspaceId)) { InkLabel("Open", compact: compact) }
				} else {
					Link(destination: identity.seeAllURL) { InkLabel("See all \(state.count)", compact: compact) }
				}
			}
		}
	}
}

/// The ink capsule: inverse surface with its label colour, 44 pt tall (32 pt on the Lock Screen,
/// where the whole card has to fit in about 160 pt).
private struct InkLabel: View {
	let text: String
	/// Pause is the quiet grey capsule; Open and See all are the white (inverse) ones.
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

/// The Lock Screen card mirrors the expanded island.
private struct LockScreenAgentsView: View {
	let identity: AgentsActivityIdentity
	let state: AgentsActivityState

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HStack(alignment: .center, spacing: MaskinSpace.s5) {
				if state.isEmpty {
					DoneMark().font(.title3)
				} else {
					AvatarStack(agents: state.agents, size: MaskinSpace.s12)
				}
				Headline(state: state)
				if state.count == 1, let agent = state.agents.first {
					TimeLabel(agent: agent).maskinText(.subhead)
				} else if !state.isEmpty {
					LevelBars()
				}
			}
			AgentsBody(state: state, compact: true)
			AgentsActions(identity: identity, state: state, compact: true)
		}
		// iOS crops the card at ~160 pt rather than growing it, so large Dynamic Type would push
		// the header and the buttons off the edges.
		.dynamicTypeSize(...DynamicTypeSize.large)
		.accessibilityElement(children: .contain)
	}
}
