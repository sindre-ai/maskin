import Foundation
import MaskinAPI
import Observation

/// One row of the activity stream under an object.
public struct TimelineItem: Identifiable, Sendable, Equatable {
	public enum Kind: Sendable, Equatable {
		case comment(String)
		/// A system event: "moved status…", "started session".
		case activity(String)
	}

	public enum Delivery: Sendable, Equatable {
		case sent
		case sending
		/// Not delivered; `retryComment` resends it with the same idempotency key.
		case failed
	}

	public var id: String
	public var kind: Kind
	public var actorId: String?
	public var date: Date?
	public var delivery: Delivery
	/// The server event id for stored items; `nil` for a comment that hasn't landed.
	public var eventId: Int?
	/// Only for local, unsent comments.
	var idempotencyKey: String?
	var parentEventId: Int?
	/// Actor ids tagged in an unsent comment, kept so a retry mentions the same people.
	var mentions: [String] = []
	/// Objects linked from the comment with `/`: ids, resolved to titles by the store.
	public var refs: [String] = []
	/// Files attached to the comment: ids, resolved to names by the store.
	public var attachments: [String] = []

	public var isLocal: Bool { eventId == nil }

	public init(
		id: String, kind: Kind, actorId: String? = nil, date: Date? = nil, delivery: Delivery = .sent,
		eventId: Int? = nil, refs: [String] = [], attachments: [String] = []
	) {
		self.init(
			id: id, kind: kind, actorId: actorId, date: date, delivery: delivery, eventId: eventId,
			idempotencyKey: nil, parentEventId: nil)
		self.refs = refs
		self.attachments = attachments
	}

	init(
		id: String, kind: Kind, actorId: String?, date: Date?, delivery: Delivery, eventId: Int?,
		idempotencyKey: String?, parentEventId: Int?
	) {
		self.id = id
		self.kind = kind
		self.actorId = actorId
		self.date = date
		self.delivery = delivery
		self.eventId = eventId
		self.idempotencyKey = idempotencyKey
		self.parentEventId = parentEventId
	}
}

/// One object on screen: the object, its links and activity, and every edit made to it.
@MainActor
@Observable
public final class ObjectDetailStore {
	public enum Phase: Equatable, Sendable {
		case loading
		case loaded
		case failed(String)
		/// The object no longer exists (deleted elsewhere).
		case gone
	}

	public let objectId: String
	public private(set) var object: WorkObject?
	public private(set) var links: [ObjectLink] = []
	public private(set) var timeline: [TimelineItem] = []
	public private(set) var phase: Phase = .loading
	public private(set) var isOffline = false
	/// A fetch has succeeded in this session. Links come from the cache but the activity stream
	/// does not, so before this an empty timeline means "not loaded yet", not "no activity".
	public private(set) var hasFetched = false
	/// The last failed write (edit, star, delete), cleared by the next successful one.
	public private(set) var actionError: String?
	public private(set) var didDelete = false
	public private(set) var isDeleting = false
	/// How current the object on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	public let directory: ObjectsDirectory
	/// The signed-in actor, to mark "You" in the timeline.
	public let currentActorId: String?

	/// Called after every successful or optimistic change so the list can mirror it.
	@ObservationIgnored public var onObjectChanged: (@MainActor (WorkObject) -> Void)?
	@ObservationIgnored public var onObjectDeleted: (@MainActor (String) -> Void)?

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private var editCount = 0
	@ObservationIgnored private let cache: SnapshotCache?

	/// The object and its links, as last seen. The activity stream is not cached: it is message
	/// text, which only ever comes fresh from the server.
	struct Snapshot: Codable, Sendable {
		var object: WorkObject
		var links: [ObjectLink]
	}

	var cacheName: String { "object.\(objectId)" }

	public init(
		objectId: String, remote: any ObjectsRemote, directory: ObjectsDirectory,
		currentActorId: String?, preload: WorkObject? = nil, cache: SnapshotCache? = nil,
		files: (any FilesRemote)? = nil
	) {
		self.filesRemote = files
		self.objectId = objectId
		self.remote = remote
		self.directory = directory
		self.currentActorId = currentActorId
		self.object = preload
		self.cache = cache
		if let entry = cache?.read(Snapshot.self, "object.\(objectId)") {
			// A preload from the list is as fresh as the list; the cached links still help.
			if preload == nil { object = entry.value.object }
			links = entry.value.links
			phase = .loaded
			freshness.hydrated(from: entry.savedAt)
		}
	}

	// MARK: Derived

	public var statusOptions: [String] {
		guard let object else { return [] }
		return directory.schema.statuses(for: object.type)
	}

	public var ownerName: String? { directory.name(for: object?.driverId) }

	public func authorName(for item: TimelineItem) -> String {
		if let id = item.actorId, id == currentActorId { return "You" }
		return directory.name(for: item.actorId) ?? "Someone"
	}

	public func isAgent(_ item: TimelineItem) -> Bool { directory.actor(for: item.actorId)?.isAgent ?? false }

	// MARK: Loading

	public func load() async {
		await directory.load()
		if object == nil { phase = .loading }
		await refresh()
	}

	/// Refetch the graph. Overlapping calls coalesce into one follow-up.
	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			let before = editCount
			do {
				let graph = try await remote.graph(objectId: objectId)
				// An edit started while this fetch was in flight would be overwritten with stale
				// data; its own completion refetches.
				if before == editCount { object = graph.object }
				links = graph.links
				mergeTimeline(graph.events)
				phase = .loaded
				hasFetched = true
				isOffline = false
				freshness.refreshed(at: cache?.now() ?? Date())
				if let object { cache?.write(Snapshot(object: object, links: links), cacheName) }
			} catch let error as ObjectsError where error.message == ObjectsRemoteMessages.notFound {
				phase = .gone
				cache?.remove(cacheName)
			} catch {
				isOffline = (error as? ObjectsError)?.isOffline ?? false
				freshness.revalidateFailed()
				if object == nil { phase = .failed(Self.message(error)) }
			}
		} while refreshQueued
	}

	/// Runs until cancelled. Events on this object (comments, edits, status changes) refetch it.
	public func observe(_ signals: AsyncStream<HubSignal>) async {
		for await signal in signals {
			if Task.isCancelled { return }
			switch signal {
			case .reconnected:
				await refresh()
			case .event(let event) where event.entityId == objectId:
				if event.action == "deleted" && event.entityType == .object {
					phase = .gone
				} else {
					await refresh()
				}
			default:
				break
			}
		}
	}

	private func mergeTimeline(_ events: [ObjectEvent]) {
		let stored = events
			.sorted { ($0.createdAt ?? .distantPast, $0.id) < ($1.createdAt ?? .distantPast, $1.id) }
			.compactMap(Self.item(from:))
		// Keep local items the server doesn't know yet (sending or failed).
		timeline = stored + timeline.filter { $0.isLocal }
		resolveReferences()
		resolveFiles()
	}

	// MARK: References

	/// Objects linked from comments, by id. A linked object that can't be fetched (deleted, or not
	/// visible) is simply absent: callers show nothing for it, never the id.
	public private(set) var references: [String: CommentReference] = [:]
	@ObservationIgnored private var resolving: Set<String> = []

	public func references(for item: TimelineItem) -> [CommentReference] {
		item.refs.compactMap { references[$0] }
	}

	/// Objects matching `query` for the `/` picker; the one on screen is never offered.
	public func searchObjects(_ query: String) async -> [CommentReference] {
		let found = (try? await remote.list(ObjectsQuery(search: query, limit: 8))) ?? []
		return found.filter { $0.id != objectId }.map(CommentReference.init)
	}

	/// Files attached to comments, by id. One that can't be resolved (expired, or not visible to
	/// this actor) is absent; the row says so instead of showing an id.
	public private(set) var files: [String: FileSummary] = [:]
	@ObservationIgnored private let filesRemote: (any FilesRemote)?
	@ObservationIgnored private var resolvingFiles: Set<String> = []

	public func attachments(for item: TimelineItem) -> [FileSummary] {
		item.attachments.compactMap { files[$0] }
	}

	private func resolveFiles() {
		guard let filesRemote else { return }
		let missing = Set(timeline.flatMap(\.attachments)).subtracting(files.keys).subtracting(resolvingFiles)
		guard !missing.isEmpty else { return }
		resolvingFiles.formUnion(missing)
		Task { [weak self] in
			let found = (try? await filesRemote.summaries(ids: Array(missing))) ?? []
			guard let self else { return }
			for file in found { files[file.id] = file }
			resolvingFiles.subtract(missing)
		}
	}

	private func resolveReferences() {
		let missing = Set(timeline.flatMap(\.refs)).subtracting(references.keys).subtracting(resolving)
		for id in missing {
			resolving.insert(id)
			Task { [weak self] in
				guard let self else { return }
				if let graph = try? await remote.graph(objectId: id) {
					references[id] = CommentReference(graph.object)
				}
				resolving.remove(id)
			}
		}
	}

	static func attachmentIDs(in data: JSONValue?) -> [String] {
		guard case .array(let values)? = data?["attachmentFileIds"] else { return [] }
		return values.compactMap(\.stringValue).filter { !$0.isEmpty }
	}

	static func item(from event: ObjectEvent) -> TimelineItem? {
		if event.action == "commented" {
			let text = event.data?["content"]?.stringValue ?? ""
			guard !text.isEmpty else { return nil }
			return TimelineItem(
				id: "e-\(event.id)", kind: .comment(text), actorId: event.actorId, date: event.createdAt,
				delivery: .sent, eventId: event.id, refs: ReferenceTrigger.ids(in: event.data?["metadata"]),
				attachments: Self.attachmentIDs(in: event.data))
		}
		let summary = (event.summary?.isEmpty == false ? event.summary : nil)
			?? event.action.replacingOccurrences(of: "_", with: " ")
		return TimelineItem(
			id: "e-\(event.id)", kind: .activity(summary), actorId: event.actorId, date: event.createdAt,
			delivery: .sent, eventId: event.id)
	}

	// MARK: Comments

	/// Appends the comment immediately, then sends it. A failure leaves it in the timeline marked
	/// `.failed`; `retryComment` resends with the same key so the server never stores it twice.
	public func postComment(
		_ text: String, mentions: [String] = [], refs: [CommentReference] = [],
		attachments: [ChatAttachmentRef] = [], parentEventId: Int? = nil
	) async {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		var item = TimelineItem(
			id: "local-\(UUID().uuidString)", kind: .comment(trimmed), actorId: currentActorId,
			date: Date(), delivery: .sending, eventId: nil, idempotencyKey: IdempotencyKey.make(),
			parentEventId: parentEventId)
		item.mentions = mentions
		item.refs = refs.map(\.id)
		for ref in refs { references[ref.id] = ref }
		item.attachments = attachments.map(\.fileID)
		for file in attachments {
			files[file.fileID] = FileSummary(
				id: file.fileID, name: file.name ?? "File", mimeType: file.mimeType ?? "application/octet-stream",
				sizeBytes: file.sizeBytes ?? 0)
		}
		timeline.append(item)
		await send(localId: item.id)
	}

	public func retryComment(_ localId: String) async {
		guard let i = timeline.firstIndex(where: { $0.id == localId }), timeline[i].delivery == .failed
		else { return }
		timeline[i].delivery = .sending
		await send(localId: localId)
	}

	/// Drop an unsent comment.
	public func discardComment(_ localId: String) {
		timeline.removeAll { $0.id == localId && $0.isLocal }
	}

	private func send(localId: String) async {
		guard let item = timeline.first(where: { $0.id == localId }), case .comment(let text) = item.kind,
			let key = item.idempotencyKey
		else { return }
		do {
			let stored = try await remote.postComment(
				objectId: objectId, content: text, mentions: item.mentions, refs: item.refs,
				attachmentFileIds: item.attachments, parentEventId: item.parentEventId, idempotencyKey: key)
			guard let i = timeline.firstIndex(where: { $0.id == localId }) else { return }
			// A refetch may already have brought the stored event in; don't show it twice.
			if timeline.contains(where: { $0.eventId == stored.id }) {
				timeline.remove(at: i)
			} else {
				timeline[i] = TimelineItem(
					id: "e-\(stored.id)", kind: .comment(text), actorId: stored.actorId ?? item.actorId,
					date: stored.createdAt ?? item.date, delivery: .sent, eventId: stored.id, refs: item.refs,
					attachments: item.attachments)
			}
		} catch {
			if let i = timeline.firstIndex(where: { $0.id == localId }) { timeline[i].delivery = .failed }
			isOffline = (error as? ObjectsError)?.isOffline ?? isOffline
		}
	}

	// MARK: Edits

	/// Applies the patch locally, sends it, and puts back exactly what the patch overwrote if the
	/// server refuses.
	public func edit(_ patch: ObjectPatch) async {
		guard let current = object else { return }
		let updated = patch.applied(to: current)
		guard updated != current else { return }
		object = updated
		onObjectChanged?(updated)
		editCount += 1
		do {
			let saved = try await remote.update(
				objectId: objectId, patch: patch, idempotencyKey: IdempotencyKey.make())
			// Keep local-only fields (star, unread) the PATCH response may not carry.
			var merged = saved
			if let now = object { merged.isStarred = now.isStarred }
			object = merged
			onObjectChanged?(merged)
			actionError = nil
		} catch {
			if var now = object {
				if patch.title != nil { now.title = current.title }
				if patch.content != nil { now.content = current.content }
				if patch.status != nil { now.status = current.status }
				object = now
				onObjectChanged?(now)
			}
			actionError = Self.message(error)
		}
		editCount += 1
	}

	public func setStatus(_ status: String) async { await edit(ObjectPatch(status: status)) }

	public func toggleStar() async {
		guard var current = object else { return }
		let starred = !current.isStarred
		current.isStarred = starred
		object = current
		onObjectChanged?(current)
		do {
			try await remote.setStarred(objectId: objectId, starred: starred)
			actionError = nil
		} catch {
			object?.isStarred = !starred
			if let object { onObjectChanged?(object) }
			actionError = Self.message(error)
		}
	}

	public func delete() async {
		guard !isDeleting else { return }
		isDeleting = true
		defer { isDeleting = false }
		do {
			try await remote.delete(objectId: objectId)
			didDelete = true
			onObjectDeleted?(objectId)
		} catch {
			actionError = Self.message(error)
		}
	}

	public func clearActionError() { actionError = nil }

	static func message(_ error: Error) -> String {
		(error as? ObjectsError)?.message ?? error.localizedDescription
	}
}

/// Strings the adapter and stores agree on.
public enum ObjectsRemoteMessages {
	public static let notFound = "Object not found"
}
