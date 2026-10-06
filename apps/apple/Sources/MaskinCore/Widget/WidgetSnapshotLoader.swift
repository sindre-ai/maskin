import Foundation

/// What the loader reads over the network. A protocol so it tests without a server.
public protocol WidgetDataSource: Sendable {
	/// The For You feed (`GET /api/subscriptions/unread`).
	func feed(workspaceId: String) async throws -> [ForYouCard]
	/// Names for the senders (`GET /api/actors`).
	func actors(workspaceId: String) async throws -> [ForYouActor]
	/// Unread notifications, capped at `WidgetSnapshot.unreadCap`.
	func unreadNotificationCount(workspaceId: String) async throws -> Int
}

/// Set by the HTTP layer when the server answers 401: the widget then shows the signed-out state
/// instead of a stale snapshot. Only the app ever clears the Keychain.
public final class WidgetUnauthorizedFlag: Sendable {
	private let state = LockedBool()
	public init() {}
	public func raise() { state.set() }
	public var isRaised: Bool { state.value }
}

private final class LockedBool: @unchecked Sendable {
	private let lock = NSLock()
	private var flag = false
	func set() { lock.withLock { flag = true } }
	var value: Bool { lock.withLock { flag } }
}

public enum WidgetLoadError: Error, Equatable, Sendable { case timeout }

/// credentials → API → snapshot. Runs in the widget extension, so: strict time budget, one
/// request per piece of data issued in parallel, and nothing is logged (titles are private).
public struct WidgetSnapshotLoader: Sendable {
	public typealias SourceFactory = @Sendable (StoredSession, WidgetUnauthorizedFlag) -> any WidgetDataSource

	private let secrets: any SecretStore
	private let cache: any WidgetSnapshotCache
	private let makeSource: SourceFactory
	private let timeout: TimeInterval
	private let now: @Sendable () -> Date

	/// - Parameter timeout: the whole load, not each request. The widget process is killed soon
	///   after its timeline provider's own budget, so a slow network falls back to the cache.
	public init(
		secrets: any SecretStore, cache: any WidgetSnapshotCache, timeout: TimeInterval = 12,
		now: @escaping @Sendable () -> Date = { Date() }, makeSource: @escaping SourceFactory
	) {
		self.secrets = secrets
		self.cache = cache
		self.makeSource = makeSource
		self.timeout = timeout
		self.now = now
	}

	/// The signed-in session, or `nil` when there is none (or no workspace is chosen yet).
	func session() -> StoredSession? {
		guard let data = try? secrets.read(),
			let stored = try? JSONDecoder().decode(StoredSession.self, from: data),
			!stored.apiKey.isEmpty, let ws = stored.workspaceId, !ws.isEmpty
		else { return nil }
		return stored
	}

	public func load() async -> WidgetState {
		guard let session = session(), let workspaceId = session.workspaceId else {
			// Whoever signed out must not leave their decisions on a lock screen.
			cache.clear()
			return .signedOut
		}
		let flag = WidgetUnauthorizedFlag()
		let source = makeSource(session, flag)
		let cached = cache.load().flatMap {
			$0.actorId == session.actorId && $0.workspaceId == workspaceId ? $0 : nil
		}
		do {
			let snapshot = try await Self.withTimeout(timeout) {
				try await Self.fetch(
					source: source, session: session, workspaceId: workspaceId,
					fallbackUnread: cached?.unreadCount ?? 0, now: now())
			}
			cache.save(snapshot)
			return .content(snapshot)
		} catch {
			if flag.isRaised {
				cache.clear()
				return .signedOut
			}
			return cached.map { .content($0) } ?? .unavailable
		}
	}

	private static func fetch(
		source: any WidgetDataSource, session: StoredSession, workspaceId: String,
		fallbackUnread: Int, now: Date
	) async throws -> WidgetSnapshot {
		async let feed = source.feed(workspaceId: workspaceId)
		// Names and the notification count are garnish: failing either must not blank the widget.
		async let actors = try? source.actors(workspaceId: workspaceId)
		async let unread = try? source.unreadNotificationCount(workspaceId: workspaceId)
		let cards = try await feed
		return WidgetSnapshotBuilder.make(
			cards: cards, actors: await actors ?? [], unreadNotifications: await unread ?? fallbackUnread,
			actorId: session.actorId, workspaceId: workspaceId, now: now)
	}

	/// Races `operation` against a timer. The loser is cancelled.
	static func withTimeout<T: Sendable>(
		_ seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T
	) async throws -> T {
		try await withThrowingTaskGroup(of: T.self) { group in
			group.addTask { try await operation() }
			group.addTask {
				try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
				throw WidgetLoadError.timeout
			}
			defer { group.cancelAll() }
			guard let first = try await group.next() else { throw WidgetLoadError.timeout }
			return first
		}
	}
}
