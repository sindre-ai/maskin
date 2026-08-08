import Foundation
import Observation

/// Holds the workspace-scoped data every tab reads. A single shared store (rather than
/// one per resource, per the plan's `ObjectsStore`/`UnreadStore` sketch) is a deliberate
/// v1 simplification — SSE just triggers a full refresh of whichever lists are loaded
/// instead of patching individual entities.
@MainActor
@Observable
final class AppModel {
	private(set) var unreadItems: [UnreadItem] = []
	private(set) var objects: [MaskinObject] = []
	private(set) var loops: [LoopSummary] = []
	private(set) var actorsById: [String: Actor] = [:]

	var isLoadingUnread = false
	var isLoadingObjects = false
	var isLoadingLoops = false
	var lastError: String?

	private let sse = SSEClient()

	var needsYouCount: Int {
		unreadItems.filter { CardClassifier.classify($0) != .thread }.count
	}

	func actor(_ id: String) -> Actor? { actorsById[id] }

	func startRealtime(workspaceId: String) {
		Task {
			await sse.connect(workspaceId: workspaceId) { [weak self] _ in
				Task { @MainActor in
					// Any live event can change unread/decision state — refresh the
					// feeds that currently drive visible UI.
					await self?.refreshUnread(workspaceId: workspaceId)
				}
			}
		}
	}

	func stopRealtime() {
		Task { await sse.disconnect() }
	}

	func loadAll(workspaceId: String) async {
		async let unread: () = refreshUnread(workspaceId: workspaceId)
		async let objs: () = refreshObjects(workspaceId: workspaceId)
		async let loopsLoad: () = refreshLoops(workspaceId: workspaceId)
		async let actors: () = refreshActors(workspaceId: workspaceId)
		_ = await (unread, objs, loopsLoad, actors)
	}

	func refreshUnread(workspaceId: String) async {
		isLoadingUnread = true
		defer { isLoadingUnread = false }
		do {
			unreadItems = try await SubscriptionsAPI.unread(workspaceId: workspaceId)
		} catch {
			lastError = (error as? APIError)?.message ?? error.localizedDescription
		}
	}

	func refreshObjects(workspaceId: String) async {
		isLoadingObjects = true
		defer { isLoadingObjects = false }
		do {
			objects = try await ObjectsAPI.list(workspaceId: workspaceId)
		} catch {
			lastError = (error as? APIError)?.message ?? error.localizedDescription
		}
	}

	func refreshLoops(workspaceId: String) async {
		isLoadingLoops = true
		defer { isLoadingLoops = false }
		do {
			loops = try await LoopsAPI.list(workspaceId: workspaceId)
		} catch {
			lastError = (error as? APIError)?.message ?? error.localizedDescription
		}
	}

	func refreshActors(workspaceId: String) async {
		do {
			let list = try await ActorsAPI.list(workspaceId: workspaceId)
			actorsById = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
		} catch {
			lastError = (error as? APIError)?.message ?? error.localizedDescription
		}
	}

	/// Approve/Hold/chip actions post a plain comment — see plan Context: there is no
	/// backend decision-state transition today, this exactly mirrors
	/// `chooseDecision` in `apps/web/src/components/foryou/foryou-queue-card.tsx`.
	func postDecision(entityId: String, label: String, workspaceId: String) async throws {
		try await EventsAPI.createComment(entityId: entityId, content: label, workspaceId: workspaceId)
		await refreshUnread(workspaceId: workspaceId)
	}

	func markRead(item: UnreadItem, workspaceId: String) async {
		guard let lastEventId = item.latestEventId else { return }
		do {
			try await SubscriptionsAPI.markRead(entityId: item.entityId, lastEventId: lastEventId, workspaceId: workspaceId)
			unreadItems.removeAll { $0.entityId == item.entityId }
		} catch {
			lastError = (error as? APIError)?.message ?? error.localizedDescription
		}
	}
}
