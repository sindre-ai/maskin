import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Integrations › Google Drive › Folder watches: the folders agents watch, with Stop watch. Read
/// and stop only; adding a watch stays in an agent's trigger settings, as on the web.
struct DriveWatchesView: View {
	@State private var store: DriveWatchesStore
	@State private var target: DriveWatch?

	init(store: DriveWatchesStore) {
		_store = State(initialValue: store)
	}

	var body: some View {
		WorkspacePage(title: "Google Drive") {
			PageGroupLabel(text: DriveWatchesCopy.label)
			switch store.phase {
			case .loaded:
				if store.watches.isEmpty {
					PageStatus(text: DriveWatchesCopy.emptyTitle)
					PageFootnote(text: DriveWatchesCopy.emptyDescription)
				} else {
					PageCard(rows: store.watches.map(row))
				}
				if let error = store.actionError { FormError(error) }
				if !store.canWrite { PageFootnote(text: DriveWatchesCopy.viewerReadOnly) }
			case .failed(let message):
				PageStatus(text: message)
				Button("Retry") { Task { await store.load() } }.buttonStyle(.primaryAction)
			default: PageStatus(text: "Loading folder watches")
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
		.confirmationDialog(
			target?.displayPath ?? "Folder",
			isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
			titleVisibility: .visible, presenting: target
		) { watch in
			Button(DriveWatchesCopy.stopWatch, role: .destructive) { Task { await store.stop(watch) } }
				.accessibilityLabel(DriveWatchesCopy.stopWatchLabel(watch.displayPath))
		}
	}

	private func row(_ watch: DriveWatch) -> PageRowModel {
		PageRowModel(
			id: watch.id, title: DriveWatch.truncatePath(watch.displayPath), subtitle: meta(watch),
			accessory: .state(PageState(DriveWatchesCopy.stopWatch, store.canWrite ? .notice : .muted)),
			action: store.canWrite && !store.stopping.contains(watch.id) ? { target = watch } : nil)
	}

	/// "Sebastian · triggers New file brief · last fired 2h ago"; a part with no source is left out.
	private func meta(_ watch: DriveWatch) -> String? {
		var parts: [String] = []
		if let human = watch.humanName { parts.append(human) }
		if !watch.triggerNames.isEmpty { parts.append("triggers \(watch.triggerNames.joined(separator: ", "))") }
		if let fired = watch.lastFiredAt {
			parts.append("last fired \(RelativeTimeFormatter.string(for: fired, style: .relative))")
		}
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
	}
}
