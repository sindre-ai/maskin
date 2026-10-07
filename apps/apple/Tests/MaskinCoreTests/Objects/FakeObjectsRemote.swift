import Foundation

@testable import MaskinCore

/// In-memory `ObjectsRemote` that records every call and can be told to fail.
final class FakeObjectsRemote: ObjectsRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var _objects: [WorkObject]
	private var _graphs: [String: ObjectGraph] = [:]
	private var _failures: Set<String> = []
	private var _listQueries: [ObjectsQuery] = []
	private var _boardQueries: [ObjectsBoardQuery] = []
	private var _commentKeys: [String] = []
	private var _commentMentions: [[String]] = []
	private var _commentRefs: [[String]] = []
	private var _commentFiles: [[String]] = []
	private var _updateKeys: [String] = []
	private var _commentCalls = 0
	private var _graphCalls = 0
	private var _nextEventId = 900
	private var _offline = false
	var delay: Duration = .zero

	init(objects: [WorkObject] = []) { _objects = objects }

	// MARK: Scripting

	var objects: [WorkObject] {
		get { lock.withLock { _objects } }
		set { lock.withLock { _objects = newValue } }
	}
	func setGraph(_ graph: ObjectGraph) { lock.withLock { _graphs[graph.object.id] = graph } }
	/// Operations named here throw: "list", "graph", "create", "update", "delete", "star", "comment".
	func fail(_ ops: String...) { lock.withLock { _failures = Set(ops) } }
	func heal() { lock.withLock { _failures = [] } }
	func goOffline(_ value: Bool) { lock.withLock { _offline = value } }

	var listQueries: [ObjectsQuery] { lock.withLock { _listQueries } }
	var boardQueries: [ObjectsBoardQuery] { lock.withLock { _boardQueries } }
	var commentKeys: [String] { lock.withLock { _commentKeys } }
	var commentMentions: [[String]] { lock.withLock { _commentMentions } }
	var commentRefs: [[String]] { lock.withLock { _commentRefs } }
	var commentFiles: [[String]] { lock.withLock { _commentFiles } }
	var updateKeys: [String] { lock.withLock { _updateKeys } }

	private func check(_ op: String) throws {
		let (failing, offline) = lock.withLock { (_failures.contains(op), _offline) }
		if failing { throw ObjectsError(offline ? "You're offline." : "boom", isOffline: offline) }
	}

	// MARK: ObjectsRemote

	func list(_ query: ObjectsQuery) async throws -> [WorkObject] {
		lock.withLock { _listQueries.append(query) }
		try await Task.sleep(for: delay)
		try check("list")
		// The real server rejects (400), not clamps, a limit over its cap.
		if query.limit > ServerLimits.maxPageSize { throw ObjectsError("400: limit above server max") }
		var result = objects
		if let type = query.type { result = result.filter { $0.type == type } }
		if let status = query.status { result = result.filter { $0.status == status } }
		if !query.search.isEmpty {
			result = result.filter { $0.displayTitle.localizedCaseInsensitiveContains(query.search) }
		}
		return Array(result.dropFirst(query.offset).prefix(query.limit))
	}

	/// One column per configured status of the type (the server's shape), filtered by `column` and
	/// paged by `offset` / `limit`; `total` counts the column before paging.
	func board(_ query: ObjectsBoardQuery) async throws -> [ObjectsBoardColumn] {
		lock.withLock { _boardQueries.append(query) }
		try check("board")
		let ofType = objects.filter { $0.type == query.type }
		let statuses = ObjectsSchema.fallback.statuses(for: query.type)
		return statuses.filter { query.column == nil || $0 == query.column }.map { status in
			let inColumn = ofType.filter { $0.status == status }
			return ObjectsBoardColumn(
				id: "status:\(status)", value: status, total: inColumn.count,
				objects: Array(inColumn.dropFirst(query.offset).prefix(query.limit)))
		}
	}

	var graphCalls: Int { lock.withLock { _graphCalls } }

	func graph(objectId: String) async throws -> ObjectGraph {
		lock.withLock { _graphCalls += 1 }
		try check("graph")
		guard let graph = lock.withLock({ _graphs[objectId] }) else {
			throw ObjectsError(ObjectsRemoteMessages.notFound)
		}
		return graph
	}

	func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject {
		try check("create")
		let created = WorkObject(
			id: "new-\(UUID().uuidString)", type: draft.type, title: draft.title, content: draft.content,
			status: draft.status, updatedAt: Date())
		lock.withLock { _objects.insert(created, at: 0) }
		return created
	}

	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject {
		lock.withLock { _updateKeys.append(idempotencyKey) }
		try check("update")
		let base = lock.withLock { _graphs[objectId]?.object } ?? objects.first { $0.id == objectId }!
		return patch.applied(to: base)
	}

	func delete(objectId: String) async throws {
		try check("delete")
		lock.withLock { _objects.removeAll { $0.id == objectId } }
	}

	func setStarred(objectId: String, starred: Bool) async throws { try check("star") }

	func postComment(
		objectId: String, content: String, mentions: [String], refs: [String],
		attachmentFileIds: [String], parentEventId: Int?, idempotencyKey: String
	) async throws -> ObjectEvent {
		lock.withLock {
			_commentFiles.append(attachmentFileIds)
			_commentRefs.append(refs)
			_commentMentions.append(mentions)
			_commentKeys.append(idempotencyKey)
			_commentCalls += 1
		}
		try check("comment")
		let id = lock.withLock { () -> Int in
			_nextEventId += 1
			return _nextEventId
		}
		return ObjectEvent(
			id: id, actorId: "me", action: "commented", data: .object(["content": .string(content)]),
			createdAt: Date())
	}

	func actors() async throws -> [ActorRef] { Fixtures.actors }
	func schema(workspaceId: String) async throws -> ObjectsSchema { .fallback }
}

enum Fixtures {
	static let actors = [
		ActorRef(id: "me", name: "Alex Preview", isAgent: false),
		ActorRef(id: "sigrid", name: "Sigrid Larsen", isAgent: false),
		ActorRef(id: "forge", name: "Forge", isAgent: true),
	]

	static func date(_ minutesAgo: Int) -> Date { Date(timeIntervalSince1970: 1_800_000_000 - Double(minutesAgo * 60)) }

	static let objects: [WorkObject] = [
		WorkObject(
			id: "t1", type: "task", title: "Wire up SSE reconnect", content: "Reconnect with backoff.",
			status: "in_progress", driverId: "forge", updatedAt: date(5)),
		WorkObject(
			id: "t2", type: "task", title: "Write migration for devices", status: "todo",
			driverId: "me", updatedAt: date(60)),
		WorkObject(
			id: "b1", type: "bet", title: "Native iOS app", content: "Ship a SwiftUI client.",
			status: "active", driverId: "sigrid", updatedAt: date(30)),
		WorkObject(
			id: "i1", type: "insight", title: "Users want push notifications", status: "new",
			updatedAt: date(120)),
		WorkObject(
			id: "t3", type: "task", title: "Design empty states", status: "in_progress", updatedAt: date(90)),
	]

	static func graph(for object: WorkObject) -> ObjectGraph {
		ObjectGraph(
			object: object,
			links: [
				ObjectLink(
					id: "r1", relation: "blocks", isOutgoing: true, otherId: "t2", otherType: "task",
					otherTitle: "Write migration for devices", otherStatus: "todo"),
				ObjectLink(
					id: "r2", relation: "breaks_into", isOutgoing: false, otherId: "b1", otherType: "bet",
					otherTitle: "Native iOS app", otherStatus: "active"),
			],
			events: [
				ObjectEvent(id: 3, actorId: "forge", action: "commented", data: .object(["content": .string("Reconnect is flaky on cellular. I'm adding **backoff** with jitter.")]), createdAt: date(20)),
				ObjectEvent(id: 1, actorId: "sigrid", action: "created", createdAt: date(300), summary: "created task"),
				ObjectEvent(id: 2, actorId: "me", action: "status_changed", createdAt: date(100), summary: "moved status from todo to in progress"),
				ObjectEvent(id: 4, actorId: "me", action: "commented", data: .object(["content": .string("Great, ship it behind the flag.")]), createdAt: date(10)),
			])
	}
}
