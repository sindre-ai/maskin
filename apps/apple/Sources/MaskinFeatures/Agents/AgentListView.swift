import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: agents grouped by state, with search and loading, empty and offline
/// states.
struct AgentListView: View {
	let store: AgentsStore
	@Binding var selection: String?
	@Binding var search: String
	var isLive = true
	/// Set on iPhone, where selecting a row pushes its detail with a zoom.
	var zoomNamespace: Namespace.ID?

	var body: some View {
		let groups = store.groups(query: search)
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			ForEach(groups) { group in
				Section {
					ForEach(group.items) { agent in
						AgentRow(agent: agent).tag(agent.id).zoomSource(id: agent.id, in: zoomNamespace)
					}
				} header: {
					MonoLabel("\(group.label) · \(group.items.count)")
				}
			}
		}
		.listStyle(.plain)
		.overlay { overlay(isEmpty: groups.isEmpty) }
		.characterRefreshable { await store.refresh() }
		.searchable(text: $search, prompt: "Search agents")
	}

	@ViewBuilder
	private func overlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.agents.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load agents", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "person.2", title: "No agents yet",
						message: "Each agent takes one job and gets on with it.")
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}

/// One agent in the list: avatar (ringed while working), name, role and last activity.
struct AgentRow: View {
	let agent: AgentSummary

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			ActorAvatar(
				name: agent.name, kind: .agent, size: MaskinSpace.s14 + MaskinSpace.s4, seed: agent.id,
				mood: AgentMood(agent.status))
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(agent.name)
						.maskinText(.headline)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					AgentStatusLabel(status: agent.status)
				}
				Text(subtitle)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(2)
				if let date = agent.lastActive {
					HStack(spacing: MaskinSpace.s2) {
						Text("Last active")
						RelativeTime(date, style: .compact)
					}
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var subtitle: String {
		if agent.status == .running, let activity = agent.latestSession?.currentActivity, !activity.isEmpty {
			return activity
		}
		return agent.role
	}

	private var accessibilityLabel: String {
		var parts = [agent.name, agent.status.label, agent.role]
		if agent.status == .running, let activity = agent.latestSession?.currentActivity { parts.append(activity) }
		return parts.joined(separator: ", ")
	}
}

/// Dot + word for an agent's state ("Working", "Paused", …). `StatusBadge` titles by raw status
/// string, which doesn't fit an agent's "running" → "Working"; colours still come from the same
/// status palette.
struct AgentStatusLabel: View {
	let status: AgentStatus

	var body: some View {
		let colors = MaskinStatus.colors(for: status.badgeKey)
		HStack(spacing: MaskinSpace.s2) {
			Circle().fill(colors.fg).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
			Text(status.label).maskinText(.caption).foregroundStyle(colors.fg)
		}
		.lineLimit(1)
		.fixedSize()
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Status \(status.label)")
	}
}
