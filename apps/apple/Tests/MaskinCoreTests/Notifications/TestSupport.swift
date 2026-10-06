import Foundation

@testable import MaskinCore

func makeNotification(
	_ id: String, status: AppNotification.Status = .pending, kind: AppNotification.Kind = .needsInput,
	at seconds: TimeInterval = 0, target: String? = nil, actions: [AppNotification.Action] = [],
	wantsText: Bool = false, source: String = "agent-1"
) -> AppNotification {
	AppNotification(
		id: id, workspaceId: "ws-1", kind: kind, title: "Title \(id)", content: "Body \(id)",
		status: status, sourceActorId: source, targetActorId: target, objectId: nil,
		createdAt: Date(timeIntervalSince1970: 1_700_000_000 + seconds), actions: actions,
		wantsText: wantsText)
}

/// In-memory source with switchable failures.
actor FakeNotificationsSource: NotificationsSource {
	var rows: [AppNotification]
	var failMutations = false
	var failList = false
	var listCalls = 0
	var statusCalls: [(String, AppNotification.Status)] = []
	var responses: [(String, JSONValue)] = []
	var deleted: [String] = []
	var actorLookups: [[String]] = []
	var known: [NotificationActor] = [NotificationActor(id: "agent-1", name: "Relay", isAgent: true)]

	init(_ rows: [AppNotification] = []) { self.rows = rows }

	func setRows(_ r: [AppNotification]) { rows = r }
	func setFailMutations(_ v: Bool) { failMutations = v }
	func setFailList(_ v: Bool) { failList = v }

	func list() async throws -> [AppNotification] {
		listCalls += 1
		if failList { throw NotificationsError("offline") }
		return rows
	}

	func setStatus(id: String, status: AppNotification.Status) async throws -> AppNotification {
		statusCalls.append((id, status))
		if failMutations { throw NotificationsError("rejected") }
		guard let i = rows.firstIndex(where: { $0.id == id }) else { throw NotificationsError("404") }
		rows[i].status = status
		return rows[i]
	}

	func delete(id: String) async throws {
		if failMutations { throw NotificationsError("rejected") }
		deleted.append(id)
		rows.removeAll { $0.id == id }
	}

	func respond(id: String, response: JSONValue) async throws -> AppNotification {
		responses.append((id, response))
		if failMutations { throw NotificationsError("rejected") }
		guard let i = rows.firstIndex(where: { $0.id == id }) else { throw NotificationsError("404") }
		rows[i].status = .resolved
		rows[i].response = response
		return rows[i]
	}

	func actors(ids: [String]) async throws -> [NotificationActor] {
		actorLookups.append(ids)
		return known.filter { ids.contains($0.id) }
	}
}
