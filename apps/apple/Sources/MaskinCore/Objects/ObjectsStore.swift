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

	public private(set) var objects: [WorkObject] = [] {
		didSet {
			// Remembered across type filters, so the type pills don't vanish once one is chosen.
			if typeFilter == nil { seenTypes.formUnion(objects.map(\.type)) }
		}
	}
	private var seenTypes: Set<String> = []
	public private(set) var phase: Phase = .idle
	public private(set) var isOffline = false
	public private(set) var isLoadingMore = false
	public private(set) var hasMore = false
	/// The last failed write (star, delete, create), cleared by the next successful action.
	public private(set) var actionError: String?

	public private(set) var typeFilter: String?
	public private(set) var statusFilter: String?
	/// Only the actor's starred objects. The API has no star filter, so this narrows what is
	/// loaded; while it is on the list keeps paging until the starred ones surface.
	public var starredOnly = false
	public private(set) var searchText = ""
	public var grouping: ObjectsGrouping = .type
	/// Sort, "Needs you only", shown properties and list/board: remembered across launches.
	public private(set) var display = ObjectsDisplay() {
		didSet { if display != oldValue { displayStorage?.save(display) } }
	}

	public let directory: ObjectsDirectory
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let displayStorage: (any ObjectsDisplayStorage)?
	/// The list on screen came from disk and has not been confirmed by the server yet, so
	/// `load()` must still revalidate it.
	@ObservationIgnored private var hydratedFromCache = false
	static let cacheName = "objects.list"
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	public init(
		remote: any ObjectsRemote, directory: ObjectsDirectory, cache: SnapshotCache? = nil,
		displayStorage: (any ObjectsDisplayStorage)? = nil
	) {
		self.remote = remote
		self.directory = directory
		self.cache = cache
		self.displayStorage = displayStorage
		if let saved = displayStorage?.load() { display = saved }
		hydrateIfNeeded()
	}

	/// Show the last-known first page before any network call. Only the unfiltered head is ever
	/// cached, so this only applies while no filter or search is set.
	private func hydrateIfNeeded() {
		guard phase == .idle, objects.isEmpty, !isFiltered, cachesHead,
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
		guard !isFiltered, cachesHead else { return }
		cache?.write(Array(objects.prefix(Self.pageSize)), Self.cacheName)
	}

	// MARK: Derived

	/// The cached head is the newest-updated page; another server order must not be stored as it.
	private var cachesHead: Bool { display.sort.serverField == "updatedAt" }

	/// `objects` narrowed by the starred and "Needs you only" filters.
	public var visibleObjects: [WorkObject] {
		var visible = objects
		if starredOnly { visible = visible.filter(\.isStarred) }
		if display.needsYouOnly { visible = visible.filter(ObjectsUrgency.needsYou) }
		return visible
	}

	/// The types the filter pills offer: those the workspace actually has objects of (schema
	/// order first), or every configured type until something has loaded.
	public var presentTypes: [String] {
		let schemaTypes = directory.schema.types
		var seen = seenTypes
		if let typeFilter { seen.insert(typeFilter) }
		if seen.isEmpty { return schemaTypes }
		return schemaTypes.filter(seen.contains) + seen.subtracting(schemaTypes).sorted()
	}

	public var groups: [ObjectGroup] {
		ObjectsGrouper.group(
			visibleObjects, by: grouping, schema: directory.schema, type: typeFilter, sort: display.sort)
	}

	/// Statuses offered by the status filter for the current type filter.
	public var statusOptions: [String] { directory.schema.statuses(for: typeFilter) }

	public var isFiltered: Bool { typeFilter != nil || statusFilter != nil || starredOnly || !searchText.isEmpty }

	private var query: ObjectsQuery {
		ObjectsQuery(
			type: typeFilter, status: statusFilter,
			search: searchText.trimmingCharacters(in: .whitespacesAndNewlines),
			limit: Self.pageSize, offset: 0, sort: display.sort)
	}

	// MARK: Loading

	/// First load (skipped once loaded; use `reload()` to force) plus the directory.
	public func load() async {
		hydrateIfNeeded()
		// The people/settings directory and the list are independent requests: run them together
		// (they used to run back to back, doubling the time to first content).
		async let directoryLoad: Void = directory.load()
		if phase == .idle || hydratedFromCache || { if case .failed = phase { true } else { false } }() {
			// With data on screen (from disk) revalidate quietly: no spinner, and a failure keeps it.
			await fetchFirstPage(showSpinner: objects.isEmpty, keepOnFailure: !objects.isEmpty)
		}
		await directoryLoad
	}

	/// Forget everything (workspace switch); the next `load()` starts clean.
	public func reset() {
		generation += 1
		objects = []
		seenTypes = []
		phase = .idle
		hasMore = false
		isOffline = false
		typeFilter = nil
		statusFilter = nil
		starredOnly = false
		searchText = ""
		actionError = nil
		hydratedFromCache = false
		freshness.reset()
	}

	/// Pull to refresh.
	public func reload() async {
		async let directoryLoad: Void = directory.load()
		await refreshInPlace()
		await directoryLoad
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

	public func setStarredOnly(_ on: Bool) async {
		guard on != starredOnly else { return }
		starredOnly = on
		// The head is cached unfiltered; coming back off the filter needs no refetch.
		if on { await loadMore() }
	}

	// MARK: Display

	public func setSort(_ sort: ObjectsSort) async {
		guard sort != display.sort else { return }
		let reorders = sort.serverField != display.sort.serverField
		display.sort = sort
		// A different server order (name) needs its own first page; the tiers are local.
		if reorders { await fetchFirstPage(showSpinner: false) }
	}

	public func setNeedsYouOnly(_ on: Bool) { display.needsYouOnly = on }

	public func toggleProperty(_ property: ObjectsProperty) { display.toggle(property) }

	/// Switching to the board needs one type (the board is per type), so it opens on the first
	/// present one when "All" is selected.
	public func setLayout(_ layout: ObjectsLayout) async {
		display.layout = layout
		if layout == .board, typeFilter == nil, let first = presentTypes.first {
			await setType(first)
		}
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
	@discardableResult
	public func toggleStar(_ id: String) async -> Bool {
		guard let index = objects.firstIndex(where: { $0.id == id }) else { return false }
		let starred = !objects[index].isStarred
		objects[index].isStarred = starred
		do {
			try await remote.setStarred(objectId: id, starred: starred)
			actionError = nil
			return true
		} catch {
			if let i = objects.firstIndex(where: { $0.id == id }) { objects[i].isStarred = !starred }
			actionError = Self.message(error)
			return false
		}
	}

	/// Sets the star on each object (bulk). Objects already in that state are skipped, not counted.
	@discardableResult
	public func setStarred(_ ids: [String], _ starred: Bool) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			guard let object = objects.first(where: { $0.id == id }), object.isStarred != starred else { continue }
			if await toggleStar(id) { result.succeeded += 1 } else { result.failed += 1 }
		}
		finish(result, action: starred ? "star" : "unstar", past: starred ? "starred" : "unstarred")
		return result
	}

	/// Moves each object to `status` (bulk). Statuses are per type, so objects whose type does not
	/// offer it are left alone and not counted.
	@discardableResult
	public func setStatus(_ ids: [String], to status: String) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			guard let object = objects.first(where: { $0.id == id }),
				directory.schema.statuses(for: object.type).contains(status)
			else { continue }
			if await setStatus(id, status) { result.succeeded += 1 } else { result.failed += 1 }
		}
		finish(result, action: "update", past: "updated")
		return result
	}

	/// Deletes each object (bulk), each rolled back to its position on its own failure.
	@discardableResult
	public func delete(_ ids: [String]) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			guard objects.contains(where: { $0.id == id }) else { continue }
			if await delete(id) { result.succeeded += 1 } else { result.failed += 1 }
		}
		finish(result, action: "delete", past: "deleted")
		return result
	}

	private func finish(_ result: BulkResult, action: String, past: String) {
		if let text = result.failureNotice(action: action, past: past, noun: "object") { actionError = text }
	}

	/// Optimistic status change with rollback.
	@discardableResult
	public func setStatus(_ id: String, _ status: String) async -> Bool {
		guard let index = objects.firstIndex(where: { $0.id == id }), objects[index].status != status
		else { return false }
		let previous = objects[index]
		objects[index].status = status
		do {
			let saved = try await remote.update(
				objectId: id, patch: ObjectPatch(status: status), idempotencyKey: IdempotencyKey.make())
			var merged = saved
			if let now = objects.first(where: { $0.id == id }) { merged.isStarred = now.isStarred }
			apply(merged)
			actionError = nil
			return true
		} catch {
			if let i = objects.firstIndex(where: { $0.id == id }) { objects[i] = previous }
			actionError = Self.message(error)
			return false
		}
	}

	/// Optimistic removal with rollback to the same position.
	@discardableResult
	public func delete(_ id: String) async -> Bool {
		guard let index = objects.firstIndex(where: { $0.id == id }) else { return false }
		let removed = objects.remove(at: index)
		do {
			try await remote.delete(objectId: id)
			actionError = nil
			return true
		} catch {
			objects.insert(removed, at: min(index, objects.count))
			actionError = Self.message(error)
			return false
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
