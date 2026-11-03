import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Items Display sheet: View, ORDERING, GROUPING, FILTERS and PROPERTIES chips, Reset in the
/// header, then Select (and New). One design with Flows, Chats and Agents.
struct ObjectsDisplaySheet: View {
	@Bindable var store: ObjectsStore
	let picking: SelectionModel
	let intents: ObjectsListIntents
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		DisplaySheet(canReset: store.canResetDisplay, onReset: { run { await store.resetDisplay() } }) {
			DisplaySection(title: nil, showsDivider: false) {
				DisplayChoice(
					label: "View",
					options: ObjectsLayout.allCases.map { ($0, $0.title) },
					selection: asyncBinding({ store.display.layout }) { v in await store.setLayout(v) })
			}
			DisplaySection(title: "Ordering") {
				DisplayChoice(
					label: "Sort by",
					options: ObjectsSort.allCases.map { ($0, $0.title) },
					selection: asyncBinding({ store.display.sort }) { v in await store.setSort(v) })
				if let labels = Self.orderLabels(for: store.display.sort) {
					DisplayChoice(
						label: "Order",
						options: [(false, labels.natural), (true, labels.reversed)],
						selection: asyncBinding({ store.display.reversed }) { v in await store.setReversed(v) })
				}
			}
			DisplaySection(title: "Grouping") {
				DisplayChoice(
					label: "Group by",
					options: ObjectsGrouping.allCases.map { ($0, $0.title) },
					selection: Binding(get: { store.display.groupBy }, set: { store.setGrouping($0) }))
			}
			DisplaySection(title: "Filters") {
				DisplayChoice(
					label: "Status",
					options: [("", "Any")] + store.statusOptions.map { ($0, MaskinStatus.sentenceLabel(for: $0)) },
					selection: asyncBinding({ store.statusFilter ?? "" }) { v in await store.setStatus(v.isEmpty ? nil : v) })
				if store.typeSummaries.count > 1 {
					DisplayChoice(
						label: "Type",
						options: [("", "Any")] + store.typeSummaries.map { ($0.id, $0.label) },
						selection: asyncBinding({ store.typeFilter ?? "" }) { v in await store.setType(v.isEmpty ? nil : v) })
				}
				DisplayChoice(
					label: "Needs you",
					options: [(false, "Everything"), (true, "Needs you")],
					selection: Binding(get: { store.display.needsYouOnly }, set: { store.setNeedsYouOnly($0) }))
			}
			DisplaySection(title: "Properties") {
				DisplayToggles(
					label: "Show",
					items: ObjectsProperty.allCases.map { property in
						DisplayToggles.Item(
							id: property.id, title: property.title,
							isOn: Binding(
								get: { store.display.shows(property) }, set: { _ in store.toggleProperty(property) }))
					})
			}
			DisplaySection(title: nil) {
				HStack(spacing: MaskinSpace.s4) {
					DisplayChip(title: "Select", isOn: false) {
						dismiss()
						picking.enter()
					}
					DisplayChip(title: "New item", isOn: false) {
						dismiss()
						intents.create()
					}
					DisplayChip(title: "Save as view", isOn: false) {
						dismiss()
						intents.namingView = true
					}
				}
			}
		}
	}

	/// A binding whose setter runs an async store call.
	private func asyncBinding<T: Sendable>(
		_ get: @escaping () -> T, _ set: @escaping @MainActor (T) async -> Void
	) -> Binding<T> {
		Binding(get: get, set: { value in Task { await set(value) } })
	}

	private func run(_ operation: @escaping @MainActor () async -> Void) { Task { await operation() } }

	/// The two Order chips for a sort; the needs-you tiers have no opposite.
	static func orderLabels(for sort: ObjectsSort) -> (natural: String, reversed: String)? {
		switch sort {
		case .needsYou: nil
		case .updated: ("Newest first", "Oldest first")
		case .name: ("A to Z", "Z to A")
		}
	}
}
