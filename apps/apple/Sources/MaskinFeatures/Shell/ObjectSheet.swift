import MaskinCore
import SwiftUI

/// An object opened from a deep link or For You: a sheet with its own `NavigationStack`, so
/// related objects push inside it and Done closes the lot.
struct ObjectSheet: View {
	let environment: AppEnvironment
	let runtime: AppRuntime
	let objectId: String

	@Environment(\.dismiss) private var dismiss
	@State private var path: [String] = []

	var body: some View {
		NavigationStack(path: $path) {
			detail(objectId)
				.toolbar {
					ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
				}
				.navigationDestination(for: String.self) { detail($0) }
		}
	}

	private func detail(_ id: String) -> some View {
		ObjectDetailScreen(
			environment: environment, objectId: id, onOpenObject: { path.append($0) },
			decisionSection: { ObjectDecisionSection(environment: environment, objectId: id) }
		)
		.id(id)
	}
}

/// The For You decision card for the object being shown, if the feed has one. It reads the same
/// `ForYouStore` / `DecisionService` / `Outbox` as the feed, so choosing here shows the same
/// receipt, Undo and queued state there.
struct ObjectDecisionSection: View {
	let environment: AppEnvironment
	let objectId: String
	@Environment(AppRuntime.self) private var appRuntime: AppRuntime?

	init(environment: AppEnvironment, objectId: String) {
		self.environment = environment
		self.objectId = objectId
	}

	/// Owned by `AppRuntime`; the same store the feed uses.
	private var runtime: ForYouRuntime? { appRuntime?.forYou }

	var body: some View {
		Group {
			if let runtime, let entry = Self.entry(for: objectId, in: runtime.store.entries) {
				let store = runtime.store
				DecisionCardView(
					entry: entry, sender: store.senderName(of: entry.card), expanded: true,
					actions: .live(store: store, entry: entry, openObject: nil))
			}
		}
		.task {
			if let store = runtime?.store, store.phase == .idle { await store.load() }
		}
	}

	/// The card to show: a decision still waiting on the reader, or one they just acted on.
	/// FYI-only cards aren't decisions, so nothing renders for them.
	static func entry(for objectId: String, in entries: [FeedEntry]) -> FeedEntry? {
		entries.first { $0.id == objectId && ($0.bucket != .fyi) }
	}
}
