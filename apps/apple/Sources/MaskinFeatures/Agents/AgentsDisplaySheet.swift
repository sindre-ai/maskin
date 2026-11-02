import MaskinCore
import MaskinDesign
import SwiftUI

/// The Agents Display sheet (handoff v15), one design with Items, Flows and Chats: Sort by and Order,
/// Group by, the Status and Team filters, and the Team and Latest properties. It reads and writes the
/// same `AgentsDisplay` the chips above the list do, so there is one state.
///
/// Present it from the Agents screen with `.sheet(isPresented:) { AgentsDisplaySheet(store: store,
/// display: $display) }` and make `AgentsScreen.displayAction` return a closure that sets that flag.
struct AgentsDisplaySheet: View {
	let store: AgentsStore
	@Binding var display: AgentsDisplay

	var body: some View {
		DisplaySheet(canReset: display.isCustomized, onReset: { display.reset() }) {
			DisplaySection(title: "Ordering", showsDivider: false) {
				DisplayChoice(
					label: "Sort by", options: AgentsSort.allCases.map { ($0, $0.title) }, selection: $display.sort)
				DisplayChoice(
					label: "Order",
					options: [(false, Self.orderLabels(for: display.sort).natural), (true, Self.orderLabels(for: display.sort).reversed)],
					selection: $display.reversed)
			}
			DisplaySection(title: "Grouping") {
				DisplayChoice(
					label: "Group by", options: AgentsGrouping.allCases.map { ($0, $0.title) },
					selection: $display.grouping)
			}
			DisplaySection(title: "Filters") {
				DisplayChoice(
					label: "Status", options: Self.statusOptions, selection: $display.status)
				let teams = store.teamChips()
				if teams.count > 1 || (teams.first.map { $0.id != AgentTeams.none } ?? false) {
					DisplayChoice(
						label: "Team",
						options: [(String?.none, "All teams")] + teams.map { (Optional($0.id), $0.label) },
						selection: $display.team)
				}
			}
			DisplaySection(title: "Properties") {
				DisplayToggles(
					label: "Show",
					items: [
						.init(id: "team", title: "Team", isOn: $display.showsTeam),
						.init(id: "latest", title: "Latest", isOn: $display.showsLatest),
					])
			}
		}
	}

	/// The Status filter's chips: every status, then the three the list tells apart.
	static let statusOptions: [(value: AgentStatus?, title: String)] = [
		(nil, "All"), (.running, "Working"), (.idle, "Idle"), (.failed, "Failed"),
	]

	/// The two Order chips for a sort.
	static func orderLabels(for sort: AgentsSort) -> (natural: String, reversed: String) {
		switch sort {
		case .status: ("Needs attention first", "Idle first")
		case .name: ("A to Z", "Z to A")
		case .sessions: ("Most first", "Fewest first")
		}
	}
}
