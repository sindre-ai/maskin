import Foundation
import Observation

/// The notification inbox's data source. A protocol so the store tests without a server;
/// the production adapter (`APINotificationsSource`) hides the generated client.
public protocol NotificationsSource: Sendable {
	/// Every notification in the workspace, in any order.
	func list() async throws -> [AppNotification]
	func setStatus(id: String, status: AppNotification.Status) async throws -> AppNotification
	func delete(id: String) async throws
	func respond(id: String, response: JSONValue) async throws -> AppNotification
	/// Names for the actors that sent notifications.
	func actors(ids: [String]) async throws -> [NotificationActor]
}

public struct NotificationsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

/// The signed-in actor's notification inbox for the selected workspace.
///
/// - `unreadCount` drives the bell / tab badge and the app-icon badge.
/// - Mutations are optimistic: the row changes at once and is restored if the server refuses
///   (`actionError` then carries the reason).
/// - Live: any `notification` event from the `EventHub`, and every `.reconnected`, triggers one
///   coalesced reload.
/// - A notification is "for me" when it has no target actor or targets the signed-in actor.
@MainActor
@Observable
public final class NotificationsStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public private(set) var notifications: [AppNotification] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actors: [String: NotificationActor] = [:]
	/// Why the last mutation failed; cleared by the next successful one or `dismissError()`.
	public private(set) var actionError: String?
	/// The last refresh failed while a previous list is still on screen.
	public private(set) var isOffline = false
	/// Ids with a mutation in flight, so a row can disable its buttons.
	public private(set) var busyIDs: Set<String> = []
	/// How current the inbox on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let source: any NotificationsSource
	@ObservationIgnored private let currentActorId: () -> String?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var boundWorkspaceId: String?
	@ObservationIgnored private var reloading = false
	@ObservationIgnored private var reloadAgain = false
	/// Bumped by `reset()` (workspace switch, sign-out). A load that started before the bump
	/// belongs to the old workspace or user and must not write its result.
	@ObservationIgnored private var generation = 0

	public init(
		source: any NotificationsSource, currentActorId: @escaping () -> String?,
		cache: SnapshotCache? = nil
	) {
		self.source = source
		self.currentActorId = currentActorId
		self.cache = cache
		hydrateIfNeeded()
	}

	/// What the inbox keeps on disk: the rows the screen shows and the names beside them.
	struct Snapshot: Codable, Sendable {
		var notifications: [AppNotification]
		var actors: [NotificationActor]
	}
	static let cacheName = "notifications.inbox"
	static let cacheLimit = 200

	private func hydrateIfNeeded() {
		guard phase == .idle, notifications.isEmpty,
			let entry = cache?.read(Snapshot.self, Self.cacheName)
		else { return }
		notifications = entry.value.notifications
		actors = Dictionary(entry.value.actors.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	private func persist() {
		cache?.write(
			Snapshot(
				notifications: Array(notifications.prefix(Self.cacheLimit)),
				actors: Array(actors.values)), Self.cacheName)
	}

	/// Production wiring: loads on `start`, then follows the environment's event hub.
	public convenience init(environment: AppEnvironment) {
		self.init(
			source: APINotificationsSource(environment: environment),
			currentActorId: { [unowned environment] in environment.auth.session?.actorId },
			cache: environment.snapshotCache)
	}

	/// Unresolved notifications nobody has opened.
	public var unreadCount: Int { notifications.lazy.filter(\.isUnread).count }

	public var isEmpty: Bool { notifications.isEmpty }

	public func actor(for id: String) -> NotificationActor? { actors[id] }

	// MARK: Loading

	/// Point the store at a workspace (dropping the previous one's rows if it changed), subscribe to
	/// live updates once, and load. Safe to call repeatedly, e.g. from `.task(id: workspaceId)`.
	public func activate(workspaceId: String?, events: EventHub?) {
		if workspaceId != boundWorkspaceId {
			reset()
			boundWorkspaceId = workspaceId
		}
		guard workspaceId != nil else { return }
		start(events: events)
	}

	/// Subscribe to live updates (once) and load. Call when the shell appears.
	public func start(events: EventHub?) {
		hydrateIfNeeded()
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .event(let e) where e.entityType == .notification: await self.reload()
					case .reconnected: await self.reload()
					default: break
					}
				}
			}
		}
		// The inbox is not the first screen: let For You, which the user is looking at, have the
		// network and CPU first. The bell shows the cached count meanwhile, and opening the inbox
		// reloads it immediately.
		let delay = initialLoadDelay
		Task { [weak self] in
			if delay > .zero { try? await Task.sleep(for: delay) }
			await self?.reload()
		}
	}

	/// How long `start` waits before the first network load. Tests set it to zero.
	public var initialLoadDelay: Duration = .seconds(1.2)

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	/// Forget everything (sign-out or workspace switch).
	public func reset() {
		generation += 1
		notifications = []
		actors = [:]
		phase = .idle
		actionError = nil
		isOffline = false
		busyIDs = []
		freshness.reset()
	}

	/// Fetch the list. Overlapping calls coalesce into one trailing reload, so a burst of events
	/// costs at most two requests.
	public func reload() async {
		if reloading {
			reloadAgain = true
			return
		}
		reloading = true
		defer { reloading = false }
		repeat {
			reloadAgain = false
			await loadOnce()
		} while reloadAgain
	}

	private func loadOnce() async {
		let mine = generation
		let me = currentActorId()
		if notifications.isEmpty { phase = .loading }
		let started = ContinuousClock.now
		do {
			let all = try await source.list()
			guard mine == generation, me == currentActorId() else { return }
			let visible = all.filter { $0.targetActorId == nil || $0.targetActorId == me }
			// Rows with a mutation in flight keep their optimistic value until it settles.
			let busy = busyIDs
			let local = Dictionary(uniqueKeysWithValues: notifications.map { ($0.id, $0) })
			notifications = Self.newestFirst(
				visible.compactMap { busy.contains($0.id) ? local[$0.id] : $0 })
			phase = .loaded
			isOffline = false
			freshness.refreshed(at: cache?.now() ?? Date())
			SyncLog.revalidated(Self.cacheName, ok: true, since: started)
			await resolveActors(generation: mine)
			if mine == generation { persist() }
		} catch {
			guard mine == generation else { return }
			isOffline = true
			freshness.revalidateFailed()
			SyncLog.revalidated(Self.cacheName, ok: false, since: started)
			// A failed refresh keeps showing what we have; only an empty screen shows the error.
			if notifications.isEmpty { phase = .failed(Self.message(error)) }
		}
	}

	private func resolveActors(generation mine: Int) async {
		let missing = Set(notifications.map(\.sourceActorId)).subtracting(actors.keys)
		guard !missing.isEmpty else { return }
		if let found = try? await source.actors(ids: missing.sorted()), mine == generation {
			for a in found { actors[a.id] = a }
		}
	}

	static func newestFirst(_ list: [AppNotification]) -> [AppNotification] {
		list.sorted {
			switch ($0.createdAt, $1.createdAt) {
			case (let a?, let b?): a != b ? a > b : $0.id > $1.id
			case (nil, _?): false
			case (_?, nil): true
			default: $0.id > $1.id
			}
		}
	}

	// MARK: Mutations (optimistic, rolled back on failure)

	public func markRead(_ id: String) async {
		guard let n = notification(id), n.status == .pending else { return }
		await setStatus(id, to: .seen)
	}

	public func markUnread(_ id: String) async {
		guard let n = notification(id), n.status == .seen else { return }
		await setStatus(id, to: .pending)
	}

	public func markAllRead() async {
		for n in notifications where n.status == .pending { await markRead(n.id) }
	}

	public func delete(_ id: String) async {
		guard let index = notifications.firstIndex(where: { $0.id == id }) else { return }
		let removed = notifications.remove(at: index)
		busyIDs.insert(id)
		defer { busyIDs.remove(id) }
		do {
			try await source.delete(id: id)
			actionError = nil
		} catch {
			insert(removed)
			actionError = Self.message(error)
		}
	}

	/// Answer an actionable notification. The row resolves at once; the agent is woken server-side.
	public func respond(to id: String, with response: JSONValue) async {
		guard let before = notification(id), before.canRespond else { return }
		replace(id) {
			$0.status = .resolved
			$0.response = response
		}
		busyIDs.insert(id)
		defer { busyIDs.remove(id) }
		do {
			let updated = try await source.respond(id: id, response: response)
			replace(id) { $0 = updated }
			actionError = nil
		} catch {
			replace(id) { $0 = before }
			actionError = Self.message(error)
		}
	}

	public func dismissError() { actionError = nil }

	private func setStatus(_ id: String, to status: AppNotification.Status) async {
		guard let before = notification(id) else { return }
		replace(id) { $0.status = status }
		busyIDs.insert(id)
		defer { busyIDs.remove(id) }
		do {
			let updated = try await source.setStatus(id: id, status: status)
			replace(id) { $0 = updated }
			actionError = nil
		} catch {
			replace(id) { $0 = before }
			actionError = Self.message(error)
		}
	}

	// MARK: Helpers

	private func notification(_ id: String) -> AppNotification? {
		notifications.first { $0.id == id }
	}

	private func replace(_ id: String, _ change: (inout AppNotification) -> Void) {
		guard let i = notifications.firstIndex(where: { $0.id == id }) else { return }
		change(&notifications[i])
	}

	private func insert(_ n: AppNotification) {
		notifications = Self.newestFirst(notifications + [n])
	}

	private static func message(_ error: any Error) -> String {
		(error as? NotificationsError)?.message ?? "Something went wrong. Try again."
	}
}
