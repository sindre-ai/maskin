import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The triggers sidebar: on and off sections with inline switches, plus all the list states.
struct TriggersListView: View {
	let store: TriggersStore
	@Binding var selection: String?
	let search: String
	var isLive = true
	let onNew: () -> Void
	@State private var pendingDelete: Trigger?

	var body: some View {
		let sections = store.sections(query: search)
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if let notice = store.notice {
				FormError(notice)
					.listRowBackground(Color.clear)
					.onTapGesture { store.notice = nil }
			}
			ForEach(sections) { section in
				Section {
					ForEach(section.items) { trigger in
						TriggerRow(
							trigger: trigger, agentName: store.agentName(for: trigger),
							onToggle: { on in Task { await store.setEnabled(trigger.id, on) } }
						)
						.tag(trigger.id)
						.listRowSeparator(.hidden)
						.swipeActions(edge: .trailing, allowsFullSwipe: false) {
							Button(role: .destructive) {
								pendingDelete = trigger
							} label: {
								Label("Delete", systemImage: "trash")
							}
						}
					}
				} header: {
					Text(section.label)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3).textCase(nil)
				}
			}
		}
		.listStyle(.plain)
		.overlay { overlay(isEmpty: sections.isEmpty) }
		.characterRefreshable { await store.refresh() }
		.confirmationDialog(
			"Delete \(pendingDelete?.name ?? "trigger")?",
			isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
			titleVisibility: .visible, presenting: pendingDelete
		) { trigger in
			Button("Delete trigger", role: .destructive) {
				Task { await store.delete(trigger.id) }
			}
		} message: { _ in
			Text("Agents will no longer be woken by it.")
		}
	}

	@ViewBuilder
	private func overlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.triggers.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load triggers", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "bolt", title: "No triggers yet",
						message: "A trigger wakes an agent on a schedule, or when something happens."
					) {
						Button("New schedule", action: onNew).buttonStyle(.primaryAction)
					}
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}
