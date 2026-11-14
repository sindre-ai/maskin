import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Folder watches group on the Google Drive page: each watched folder with who it belongs to,
/// its triggers and when it last fired, and a stop button. Adding a watch is an agent's trigger
/// setting, so the empty state says where watches come from.
struct DriveWatchesBlock: View {
	let store: DriveWatchesStore
	@State private var pendingStop: DriveWatch?

	var body: some View {
		Group {
			PageGroupLabel(text: "Folder watches")
			switch store.phase {
			case .loaded(let watches):
				if watches.isEmpty {
					PageStatus(text: "No folders are being watched. Watches are set up from an agent's trigger settings.")
				} else {
					PageCard(rows: watches.map(row))
				}
				if let error = store.actionError { FormError(error) }
			case .failed(let message): PageStatus(text: message)
			default: PageStatus(text: "Loading folder watches")
			}
		}
		.confirmationDialog(
			pendingStop.map { "Stop watching \($0.displayPath)?" } ?? "Stop watching?",
			isPresented: Binding(get: { pendingStop != nil }, set: { if !$0 { pendingStop = nil } }),
			titleVisibility: .visible, presenting: pendingStop
		) { watch in
			Button("Stop watch", role: .destructive) { Task { await store.stop(watch) } }
		} message: { _ in
			Text("Triggers that listen to this folder stop firing.")
		}
	}

	private func row(_ watch: DriveWatch) -> PageRowModel {
		var parts: [String] = []
		if let account = watch.account { parts.append(account) }
		if !watch.triggerNames.isEmpty { parts.append("triggers " + watch.triggerNames.joined(separator: ", ")) }
		if let fired = watch.lastFiredAt {
			parts.append("last fired " + fired.formatted(.relative(presentation: .named)))
		}
		return PageRowModel(
			id: watch.id, title: watch.displayPath, subtitle: parts.isEmpty ? nil : parts.joined(separator: " · "),
			accessory: store.stoppingIDs.contains(watch.id)
				? .state(PageState("Stopping", .muted)) : .state(PageState("Watching", .active)),
			action: store.canManage ? { pendingStop = watch } : nil)
	}
}
