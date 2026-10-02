import Foundation
import MaskinAPI
import Observation

/// The Objects list: type + status filters, search, grouping, pagination, stars, and live refresh
/// from the event hub.
@MainActor
@Observable
public final class ObjectsStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public static let pageSize = 50

	public private(set) var objects: [WorkObject] = []
	public private(set) var phase: Phase = .idle
	public private(set) var isOffline = false
	public private(set) var isLoadingMore = false
	public private(set) var hasMore = false
	/// The last failed write (star, delete, create), cleared by the next successful action.
	public private(set) var actionError: String?

	public private(set) var typeFilter: String?
	public private(set) var statusFilter: String?
	public private(set) var searchText = ""
	public var grouping: ObjectsGrouping = .status

	public let directory: ObjectsDirectory
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private let cache: SnapshotCache?
	/// The list on screen came from disk and has not been confirmed by the server yet, so
	/// `load()` must still revalidate it.
	@ObservationIgnored private var hydratedFromCache = false
	static let cacheName = "objects.list"
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	public init(
		remote: any ObjectsRemote, directory: ObjectsDirectory, cache: SnapshotCache? = nil
	) {
		self.remote = remote
		self.directory = directory
		self.cache = cache
		hydrateIfNeeded()
	}

	/// Show the last-known first page before any network call. Only the unfiltered head is ever
	/// cached, so this only applies while no filter or search is set.
	private func hydrateIfNeeded() {
		guard phase == .idle, objects.isEmpty, !isFiltered,
			let entry = cache?.read([WorkObject].self, Self.cacheName)
		else { return }
		objects = entry.value
		hasMore = entry.value.count >= Self.pageSize
		phase = .loaded
		hydratedFromCache = true
		freshness.hydrated(from: entry.savedAt)
	}

	/// Remember the unfiltered head so the next launch opens on it.
	private func persistHead() {
		guard !isFiltered else { return }
		cache?.write(Array(objects.prefix(Self.pageSize)), Self.cacheName)
	}

	// MARK: Derived

	public var groups: [ObjectGroup] {
		ObjectsGrouper.group(objects, by: grouping, schema: directory.schema, type: typeFilter)
	}

	/// Statuses offered by the status filter for the current type filter.
	public var statusOptions: [String] { directory.schema.statuses(for: typeFilter) }

	public var isFiltered: Bool { typeFilter != nil || statusFilter != nil || !searchText.isEmpty }

	private var query: ObjectsQuery {
		ObjectsQuery(
			type: typeFilter, status: statusFilter,
			search: searchText.trimmingCharacters(in: .whitespacesAndNewlines),
			limit: Self.pageSize, offset: 0)
	}

	// MARK: Loading

	/// First load (skipped once loaded; use `reload()` to force) plus the directory.
	public func load() async {
		hydrateIfNeeded()
		await directory.load()
		guard phase == .idle || hydratedFromCache || { if case .failed = phase { true } else { false } }()
		else { return }
		// With data on screen (from disk) revalidate quietly: no spinner, and a failure keeps it.
		await fetchFirstPage(showSpinner: objects.isEmpty, keepOnFailure: !objects.isEmpty)
	}

	/// Forget everything (workspace switch); the next `load()` starts clean.
	public func reset() {
		generation += 1
		objects = []
		phase = .idle
		hasMore = false
		isOffline = false
		typeFilter = nil
		statusFilter = nil
		searchText = ""
		actionError = nil
		hydratedFromCache = false
		freshness.reset()
	}

	/// Pull to refresh.
	public func reload() async {
		await directory.load()
		await refreshInPlace()
	}

	public func loadMore() async {
		guard hasMore, !isLoadingMore, phase == .loaded else { return }
		isLoadingMore = true
		defer { isLoadingMore = false }
		let mine = generation
		var next = query
		next.offset = objects.count
		do {
			let page = try await remote.list(next)
			guard mine == generation else { return }
			let known = Set(objects.map(\.id))
			objects += page.filter { !known.contains($0.id) }
			hasMore = page.count >= Self.pageSize
		} catch {
			guard mine == generation else { return }
			isOffline = (error as? ObjectsError)?.isOffline ?? false
		}
	}

	public func setType(_ type: String?) async {
		guard type != typeFilter else { return }
		typeFilter = type
		// A status that doesn't belong to the new type would filter everything out.
		if let statusFilter, !statusOptions.contains(statusFilter) { self.statusFilter = nil }
		await fetchFirstPage(showSpinner: true)
	}

	public func setStatus(_ status: String?) async {
		guard status != statusFilter else { return }
		statusFilter = status
		await fetchFirstPage(showSpinner: true)
	}

	public func setSearch(_ text: String) async {
		guard text != searchText else { return }
		searchText = text
		await fetchFirstPage(showSpinner: false)
	}

	private func fetchFirstPage(showSpinner: Bool, keepOnFailure: Bool = false) async {
		generation += 1
		let mine = generation
		let started = ContinuousClock.now
		if showSpinner || objects.isEmpty { phase = .loading }
		do {
			let page = try await remote.list(query)
			guard mine == generation else { return }
			objects = page
			hasMore = page.count >= Self.pageSize
			phase = .loaded
			isOffline = false
			hydratedFromCache = false
			freshness.refreshed(at: cache?.now() ?? Date())
			persistHead()
			SyncLog.revalidated(Self.cacheName, ok: true, since: started)
		} catch {
			guard mine == generation else { return }
			isOffline = (error as? ObjectsError)?.isOffline ?? false
			SyncLog.revalidated(Self.cacheName, ok: false, since: started)
			if keepOnFailure {
				// A failed revalidate never blanks good data.
				phase = .loaded
				freshness.revalidateFailed()
			} else {
				phase = .failed(Self.message(error))
			}
		}
	}

	/// Refetch everything currently loaded without flashing a spinner. Concurrent requests
	/// coalesce into one follow-up fetch.
	func refreshInPlace() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if phase == .idle || phase == .loading {
				await fetchFirstPage(showSpinner: true)
				continue
			}
			let mine = generation
			var q = query
			q.limit = ServerLimits.refreshLimit(minimum: Self.pageSize, loaded: objects.count)
			do {
				let page = try await remote.list(q)
				guard mine == generation else { continue }
				// Beyond the server cap only the head is re-read; rows paged in past it are kept.
				let keptTail = objects.count > q.limit
				objects = ServerLimits.mergeHead(head: page, previous: objects)
				hasMore = keptTail ? hasMore : page.count >= q.limit
				phase = .loaded
				isOffline = false
				hydratedFromCache = false
				freshness.refreshed(at: cache?.now() ?? Date())
				persistHead()
			} catch {
				guard mine == generation else { continue }
				isOffline = (error as? ObjectsError)?.isOffline ?? false
				freshness.revalidateFailed()
				if objects.isEmpty {
					phase = .failed(Self.message(error))
				} else if !isOffline {
					// Don't let live updates stop silently.
					actionError = "Couldn't refresh the list. \(Self.message(error))"
				}
			}
		} while refreshQueued
	}

	// MARK: Live updates

	/// Runs until cancelled. Object events refresh the list; a reconnect refetches it.
	public func observe(_ signals: AsyncStream<HubSignal>) async {
		for await signal in signals {
			if Task.isCancelled { return }
			switch signal {
			case .reconnected:
				await refreshInPlace()
			case .event(let event) where event.entityType == .object:
				if event.action == "deleted", let id = event.entityId {
					objects.removeAll { $0.id == id }
				} else if phase != .idle {
					await refreshInPlace()
				}
			default:
				break
			}
		}
	}

	// MARK: Writes

	/// Optimistic star toggle with rollback.
	public func toggleStar(_ id: String) async {
		guard let index = objects.firstIndex(where: { $0.id == id }) else { return }
		let starred = !objects[index].isStarred
		objects[index].isStarred = starred
		do {
			try await remote.setStarred(objectId: id, starred: starred)
			actionError = nil
		} catch {
			if let i = objects.firstIndex(where: { $0.id == id }) { objects[i].isStarred = !starred }
			actionError = Self.message(error)
		}
	}

	/// Optimistic removal with rollback to the same position.
	public func delete(_ id: String) async {
		guard let index = objects.firstIndex(where: { $0.id == id }) else { return }
		let removed = objects.remove(at: index)
		do {
			try await remote.delete(objectId: id)
			actionError = nil
		} catch {
			objects.insert(removed, at: min(index, objects.count))
			actionError = Self.message(error)
		}
	}

	/// Creates an object and puts it at the top of the list when it matches the current filters.
	@discardableResult
	public func create(_ draft: ObjectDraft, idempotencyKey: String = IdempotencyKey.make()) async -> WorkObject? {
		do {
			let created = try await remote.create(draft, idempotencyKey: idempotencyKey)
			actionError = nil
			if !objects.contains(where: { $0.id == created.id }), matchesFilters(created) {
				objects.insert(created, at: 0)
			}
			return created
		} catch {
			actionError = Self.message(error)
			return nil
		}
	}

	/// Merge an object another screen just changed (the detail screen's optimistic edits).
	public func apply(_ object: WorkObject) {
		if let i = objects.firstIndex(where: { $0.id == object.id }) {
			if statusFilter != nil, object.status != statusFilter {
				objects.remove(at: i)
			} else {
				objects[i] = object
			}
		}
	}

	public func remove(_ id: String) { objects.removeAll { $0.id == id } }

	public func clearActionError() { actionError = nil }

	private func matchesFilters(_ object: WorkObject) -> Bool {
		if let typeFilter, object.type != typeFilter { return false }
		if let statusFilter, object.status != statusFilter { return false }
		if !searchText.isEmpty {
			return object.displayTitle.localizedCaseInsensitiveContains(searchText)
		}
		return true
	}

	static func message(_ error: Error) -> String {
		(error as? ObjectsError)?.message ?? error.localizedDescription
	}
}
