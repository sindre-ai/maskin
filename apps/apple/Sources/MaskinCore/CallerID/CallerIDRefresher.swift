import Foundation

/// Where the contacts that carry a phone number come from.
public protocol CallerIDContactSource: Sendable {
	func contactsWithPhone() async throws -> [WorkObject]
}

/// Pages through every contact (the list has no "phone present" filter) and keeps the ones with a
/// phone number. Roughly 7,000 contacts is 70 pages of 100, read at most once a day.
public struct RemoteCallerIDContactSource: CallerIDContactSource {
	/// A hard stop on paging: 30,000 contacts.
	static let maxPages = 300

	private let fetchPage: @Sendable (ObjectsQuery) async throws -> [WorkObject]

	public init(fetchPage: @escaping @Sendable (ObjectsQuery) async throws -> [WorkObject]) {
		self.fetchPage = fetchPage
	}

	public init(remote: any ObjectsRemote) {
		self.init { try await remote.list($0) }
	}

	public func contactsWithPhone() async throws -> [WorkObject] {
		var found: [WorkObject] = []
		for page in 0..<Self.maxPages {
			let rows = try await fetchPage(
				ObjectsQuery(
					type: "contact", limit: ServerLimits.maxPageSize, offset: page * ServerLimits.maxPageSize,
					sort: .name))
			found += rows.filter { !($0.metadata["phone"] ?? "").isEmpty }
			if rows.count < ServerLimits.maxPageSize { break }
		}
		return found
	}
}

/// When the list was last built, kept across launches.
public protocol CallerIDRefreshMarker: Sendable {
	var lastRefresh: Date? { get }
	func set(_ date: Date?)
}

public final class InMemoryCallerIDRefreshMarker: CallerIDRefreshMarker, @unchecked Sendable {
	private let lock = NSLock()
	private var date: Date?
	public init(_ date: Date? = nil) { self.date = date }
	public var lastRefresh: Date? { lock.withLock { date } }
	public func set(_ date: Date?) { lock.withLock { self.date = date } }
}

public struct UserDefaultsCallerIDRefreshMarker: CallerIDRefreshMarker, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String
	public init(defaults: UserDefaults = .standard, key: String = "callerID.lastRefresh.v1") {
		self.defaults = defaults
		self.key = key
	}
	public var lastRefresh: Date? { defaults.object(forKey: key) as? Date }
	public func set(_ date: Date?) {
		if let date { defaults.set(date, forKey: key) } else { defaults.removeObject(forKey: key) }
	}
}

/// Keeps the file the phone loads current: rebuilt when the app opens (at most once every 24
/// hours) or when asked to, and deleted at sign-out.
public actor CallerIDRefresher {
	public enum Outcome: Equatable, Sendable {
		/// The file was rewritten with this many numbers.
		case refreshed(count: Int)
		/// Nothing to do: refreshed within the last 24 hours, or a refresh is already running.
		case skipped
		/// The contacts could not be read or the file could not be written. The old file stays and
		/// the next open tries again.
		case failed
	}

	public static let minimumInterval: TimeInterval = 24 * 60 * 60

	private let source: any CallerIDContactSource
	private let store: any CallerIDListStoring
	private let marker: any CallerIDRefreshMarker
	private let now: @Sendable () -> Date
	private var isRefreshing = false
	/// Bumped by `wipe()`, so a refresh that was reading contacts when the person signed out does not
	/// write them back afterwards.
	private var generation = 0

	public init(
		source: any CallerIDContactSource, store: any CallerIDListStoring,
		marker: any CallerIDRefreshMarker = InMemoryCallerIDRefreshMarker(),
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.source = source
		self.store = store
		self.marker = marker
		self.now = now
	}

	/// The app opened (`force` false) or a person asked for a refresh (`force` true).
	@discardableResult
	public func refresh(force: Bool = false) async -> Outcome {
		guard !isRefreshing else { return .skipped }
		if !force, let last = marker.lastRefresh, now().timeIntervalSince(last) < Self.minimumInterval {
			return .skipped
		}
		isRefreshing = true
		defer { isRefreshing = false }
		let started = generation
		do {
			let entries = CallerIDListBuilder.build(from: try await source.contactsWithPhone())
			guard started == generation else { return .skipped }
			try store.save(entries)
			marker.set(now())
			return .refreshed(count: entries.count)
		} catch {
			return .failed
		}
	}

	/// Sign-out: the file goes, and the next sign-in builds it again from scratch.
	public func wipe() {
		generation += 1
		store.clear()
		marker.set(nil)
	}
}
