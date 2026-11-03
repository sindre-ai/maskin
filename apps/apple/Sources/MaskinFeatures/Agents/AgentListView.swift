import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: search, status and team chips, then the agents grouped as the person
/// chose in Display, with loading, empty and offline states.
struct AgentListView: View {
	let store: AgentsStore
	@Binding var selection: String?
	@Binding var search: String
	/// The person's Display choices; the chips write the status and team filters of it.
	@Binding var display: AgentsDisplay
	var isLive = true
	/// Set on iPhone, where selecting a row pushes its detail with a zoom.
	var zoomNamespace: Namespace.ID?
	/// Opens the Display sheet. Nil hides the Display chip.
	var onDisplay: (() -> Void)?
	/// Rows show a chevron when tapping pushes the detail (iPhone), not in a split sidebar.
	var showsChevron = true

	var body: some View {
		let sections = store.sections(query: search, display: display)
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if !store.agents.isEmpty {
				AgentChipRows(store: store, display: $display, onDisplay: onDisplay)
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			ForEach(sections) { section in
				Section {
					ForEach(section.items) { agent in
						AgentRow(
							agent: agent, team: display.rowShowsTeam ? store.team(of: agent.id) : nil,
							showsLatest: display.showsLatest, showsChevron: showsChevron
						)
						.tag(agent.id).zoomSource(id: agent.id, in: zoomNamespace)
					}
				} header: {
					if let title = section.title {
						HStack(spacing: MaskinSpace.s3) {
							Text(title)
							Text("\(section.items.count)").foregroundStyle(MaskinColor.ink5)
						}
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3)
						.textCase(nil)
					}
				}
			}
		}
		.listStyle(.plain)
		.overlay { overlay(isEmpty: sections.isEmpty) }
		.refreshable { await store.refresh() }
		.searchable(text: $search, prompt: "Search agents")
		#if os(iOS)
		.modifier(WorkingSubtitle(count: store.workingCount))
		#endif
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
				if store.agents.isEmpty {
					EmptyState(
						symbol: "person.2", title: "No agents yet",
						message: "Each agent takes one job and gets on with it.")
				} else if search.isEmpty {
					EmptyState(symbol: "person.2", title: "No agents match") {
						Button("Show all") { display.status = nil; display.team = nil }
							.buttonStyle(.secondaryAction)
					}
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}

/// "4 working" under the large title, when anything is.
private struct WorkingSubtitle: ViewModifier {
	let count: Int

	func body(content: Content) -> some View {
		if #available(iOS 26.0, *), count > 0 {
			content.navigationSubtitle("\(count) working")
		} else {
			content
		}
	}
}

/// The two chip rows above the list: Display and the status filter, then the team filter.
private struct AgentChipRows: View {
	let store: AgentsStore
	@Binding var display: AgentsDisplay
	var onDisplay: (() -> Void)?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s4) {
					if let onDisplay {
						Button(action: onDisplay) {
							Label("Display", systemImage: "slider.horizontal.3")
								.maskinText(.subhead).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink)
								.padding(.horizontal, MaskinSpace.s8)
								.frame(minHeight: MaskinSpace.touchMin)
								.background(MaskinSurface.fill, in: Capsule())
						}
						.buttonStyle(.maskinPressed(.shrink))
					}
					ForEach(store.statusChips(team: display.team)) { chip in
						let selected = (display.status?.rawValue ?? "all") == chip.id
						AgentFilterChip(label: chip.label, count: chip.count, selected: selected, outlined: false) {
							display.status = AgentStatus(rawValue: chip.id)
						}
					}
				}
				.padding(.horizontal, MaskinSpace.s9)
			}
			let teams = store.teamChips()
			if teams.count > 1 || (teams.first.map { $0.id != AgentTeams.none } ?? false) {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: MaskinSpace.s4) {
						ForEach(teams) { chip in
							let selected = display.team == chip.id
							AgentFilterChip(label: chip.label, count: chip.count, selected: selected, outlined: true) {
								display.team = selected ? nil : chip.id
							}
						}
					}
					.padding(.horizontal, MaskinSpace.s9)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
	}
}

/// A pill with a label and a count: ink-filled when chosen (status), outlined (team).
struct AgentFilterChip: View {
	let label: String
	var count: Int?
	let selected: Bool
	var outlined = false
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			HStack(spacing: MaskinSpace.s2) {
				Text(label).fontWeight(.semibold)
				if let count {
					Text("\(count)").foregroundStyle(selected && !outlined ? MaskinSurface.card : MaskinColor.ink5)
				}
			}
			.maskinText(.subhead)
			.lineLimit(1)
			.foregroundStyle(foreground)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(fill, in: Capsule())
			.overlay { if outlined { Capsule().strokeBorder(selected ? MaskinColor.ink : MaskinSurface.line) } }
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(count.map { "\(label), \($0)" } ?? label)
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private var foreground: Color {
		if outlined { return selected ? MaskinColor.ink : MaskinColor.ink4 }
		return selected ? MaskinSurface.card : MaskinColor.ink
	}

	private var fill: Color {
		if outlined { return selected ? MaskinSurface.fill : .clear }
		return selected ? MaskinColor.ink : MaskinSurface.fill
	}
}

/// One agent in the list: avatar (ringed while working), name, role, and optionally its team
/// and latest activity, the state on the right and a chevron when it opens the agent.
struct AgentRow: View {
	let agent: AgentSummary
	var team: String?
	var showsLatest = false
	var showsChevron = true

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			ActorAvatar(
				name: agent.name, kind: .agent, size: MaskinSpace.s14 + MaskinSpace.s4, seed: agent.id,
				mood: AgentMood(agent.status))
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(agent.name)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				Text(agent.role)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				if let team {
					Text(team).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
				}
				if showsLatest {
					Text(agent.latestLine()).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			AgentStatusLabel(status: agent.status)
			if showsChevron {
				Image(systemName: "chevron.right")
					.font(.footnote.weight(.semibold))
					.foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var accessibilityLabel: String {
		var parts = [agent.name, agent.status.label, agent.role]
		if let team { parts.append(team) }
		if showsLatest { parts.append(agent.latestLine()) }
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
