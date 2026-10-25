import Foundation
import MaskinAPI
import Observation

/// The Objects list: scope (Needs you / All / Favourites / a type / a saved view), status filter,
/// search, grouping, pagination, stars, and live refresh from the event hub. Also keeps an
/// unfiltered *inventory* (the newest `inventoryLimit` objects) for the per-type counts in the
/// tabs and the Go to sheet, since the API has no count endpoint.
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
	/// How many objects the counts are based on. Beyond it a count shows as "100+".
	public static let inventoryLimit = ServerLimits.maxPageSize

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

	/// Where the tab is. Drives `typeFilter` / `starredOnly` / the needs-you narrowing.
	public private(set) var scope: ObjectsScope = .all
	public private(set) var typeFilter: String?
	public private(set) var statusFilter: String?
	/// Only the actor's starred objects. The API has no star filter, so this narrows what is
	/// loaded; while it is on the list keeps paging until the starred ones surface.
	public var starredOnly = false
	public private(set) var searchText = ""
	/// Kept for callers that only know about grouping; persisted through `display`.
	public var grouping: ObjectsGrouping {
		get { display.groupBy }
		set { display.groupBy = newValue }
	}
	/// Sort, "Needs you only", shown properties, list/board, grouping and folded groups:
	/// remembered across launches.
	public private(set) var display = ObjectsDisplay() {
		didSet { if display != oldValue { displayStorage?.save(display) } }
	}

	/// The newest objects across every type, for counts. Local writes are mirrored into it.
	public private(set) var inventory: [WorkObject] = []
	/// The inventory hit the server cap: counts are floors.
	public private(set) var inventoryCapped = false
	/// Open asks for the reader by object id (from the For You feed, via `applyAsks`).
	public private(set) var asks: [String: ObjectAsk] = [:]

	public let directory: ObjectsDirectory
	public let savedViews: SavedViewsStore
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let displayStorage: (any ObjectsDisplayStorage)?
	/// The list on screen came from disk and has not been confirmed by the server yet, so
	/// `load()` must still revalidate it.
	@ObservationIgnored private var hydratedFromCache = false
	static let cacheName = "objects.list"
	static let inventoryCacheName = "objects.inventory"
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	@ObservationIgnored private var pendingDeletes: [String: PendingDelete] = [:]

	private struct PendingDelete {
		var object: WorkObject
		var index: Int
		var inventoryIndex: Int?
		var task: Task<Void, Never>
	}

	public init(
		remote: any ObjectsRemote, directory: ObjectsDirectory, cache: SnapshotCache? = nil,
		displayStorage: (any ObjectsDisplayStorage)? = nil, defaults: UserDefaults = .standard
	) {
		self.remote = remote
		self.directory = directory
		self.cache = cache
		self.displayStorage = displayStorage
		self.savedViews = SavedViewsStore(defaults: defaults)
		if let saved = displayStorage?.load() { display = saved }
		hydrateIfNeeded()
	}

	/// Points the saved views at `workspaceId` (call on every workspace change).
	public func bindWorkspace(_ workspaceId: String?) {
		savedViews.bind(workspaceId: workspaceId)
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
		if let stock = cache?.read([WorkObject].self, Self.inventoryCacheName) {
			inventory = stock.value
			inventoryCapped = stock.value.count >= Self.inventoryLimit
		}
	}

	/// Remember the unfiltered head so the next launch opens on it.
	private func persistHead() {
		guard !isFiltered, cachesHead else { return }
		cache?.write(Array(objects.prefix(Self.pageSize)), Self.cacheName)
	}

	// MARK: Derived

	/// The cached head is the newest-updated page; another server order must not be stored as it.
	private var cachesHead: Bool { display.sort.serverField == "updatedAt" }

	/// A saved view resolves to the scope it narrows to.
	public var effectiveScope: ObjectsScope {
		if case .saved(let id) = scope { return savedViews.view(id: id)?.scope ?? .all }
		return scope
	}

	/// The large title.
	public var title: String {
		scope.title(schema: directory.schema) { [savedViews] in savedViews.name(of: $0) }
	}

	/// The Needs you tab, or the Display menu's "Needs you only".
	public var needsYouOnly: Bool { effectiveScope == .needsYou || display.needsYouOnly }

	/// Rows show a type glyph only when types mix.
	public var mixesTypes: Bool { typeFilter == nil }

	public func ask(for objectId: String) -> ObjectAsk? { asks[objectId] }

	/// An open ask for the reader, or the data's own needs-you signals (unread, a review).
	public func needsYou(_ object: WorkObject) -> Bool {
		asks[object.id] != nil || ObjectsUrgency.needsYou(object)
	}

	/// Everything known locally, inventory first, the loaded list filling in the rest.
	private var known: [WorkObject] {
		var seen = Set(inventory.map(\.id))
		return inventory + objects.filter { seen.insert($0.id).inserted }
	}

	/// `objects` narrowed by the client-side filters (stars, needs-you).
	public var visibleObjects: [WorkObject] {
		var visible = needsYouOnly && typeFilter == nil && effectiveScope == .needsYou ? known : objects
		if starredOnly { visible = visible.filter(\.isStarred) }
		if needsYouOnly { visible = visible.filter(needsYou) }
		return visible
	}

	/// The types the tabs offer: those the workspace actually has objects of (product order), or
	/// every configured type until something has loaded, plus the selected one.
	public var presentTypes: [String] {
		var seen = seenTypes.union(inventory.map(\.type))
		if let typeFilter { seen.insert(typeFilter) }
		// The inventory is only the newest page: a type whose objects are all older never shows up
		// in it, so once it is full every configured type stays on offer.
		if seen.isEmpty || inventoryCapped { seen.formUnion(directory.schema.types) }
		let schema = directory.schema
		return ObjectTypeCatalog.sorted(Array(seen)) { schema.displayName(for: $0) }
	}

	/// One summary per present type, in product order, with its count and how many need you.
	public var typeSummaries: [ObjectTypeSummary] {
		var counts: [String: (total: Int, needs: Int)] = [:]
		for object in known {
			var entry = counts[object.type] ?? (0, 0)
			entry.total += 1
			if needsYou(object) { entry.needs += 1 }
			counts[object.type] = entry
		}
		let schema = directory.schema
		return presentTypes.map { type in
			let entry = counts[type] ?? (0, 0)
			return ObjectTypeSummary(
				id: type, label: ObjectTypeCatalog.pluralLabel(for: type, displayName: schema.displayName(for: type)),
				count: entry.total, needsYou: entry.needs, isCapped: inventoryCapped)
		}
	}

	public var needsYouCount: Int { known.filter(needsYou).count }
	public var favouritesCount: Int { known.filter(\.isStarred).count }
	public var totalCount: Int { known.count }
	/// "48" or "100+".
	public var totalCountLabel: String { inventoryCapped ? "\(totalCount)+" : "\(totalCount)" }

	public func count(of view: SavedView) -> Int {
		known.filter { view.matches($0, needsYou: needsYou($0)) }.count
	}

	public var groups: [ObjectGroup] {
		ObjectsGrouper.group(
			visibleObjects, by: display.groupBy, schema: directory.schema, type: typeFilter, sort: display.sort)
	}

	/// Statuses offered by the status filter for the current type filter.
	public var statusOptions: [String] { directory.schema.statuses(for: typeFilter) }

	public var isFiltered: Bool {
		typeFilter != nil || statusFilter != nil || starredOnly || !searchText.isEmpty || effectiveScope == .needsYou
	}

	private var query: ObjectsQuery {
		ObjectsQuery(
			type: typeFilter, status: statusFilter,
			search: searchText.trimmingCharacters(in: .whitespacesAndNewlines),
			limit: Self.pageSize, offset: 0, sort: display.sort)
	}

	// MARK: Loading

	/// First load (skipped once loaded; use `reload()` to force) plus the directory and inventory.
	public func load() async {
		hydrateIfNeeded()
		// The people/settings directory, the inventory and the list are independent requests: run
		// them together (they used to run back to back, doubling the time to first content).
		async let directoryLoad: Void = directory.load()
		async let inventoryLoad: Void = refreshInventory()
		if phase == .idle || hydratedFromCache || { if case .failed = phase { true } else { false } }() {
			// With data on screen (from disk) revalidate quietly: no spinner, and a failure keeps it.
			await fetchFirstPage(showSpinner: objects.isEmpty, keepOnFailure: !objects.isEmpty)
		}
		await directoryLoad
		await inventoryLoad
	}

	/// Forget everything (workspace switch); the next `load()` starts clean.
	public func reset() {
		generation += 1
		for pending in pendingDeletes.values { pending.task.cancel() }
		pendingDeletes = [:]
		objects = []
		seenTypes = []
		inventory = []
		inventoryCapped = false
		asks = [:]
		phase = .idle
		hasMore = false
		isOffline = false
		scope = .all
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
		async let inventoryLoad: Void = refreshInventory()
		await refreshInPlace()
		await directoryLoad
		await inventoryLoad
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

	/// Re-reads the newest `inventoryLimit` objects across every type. Failures keep the old stock.
	public func refreshInventory() async {
		let mine = generation
		do {
			let stock = try await remote.list(ObjectsQuery(limit: Self.inventoryLimit, offset: 0, sort: .updated))
			guard mine == generation else { return }
			inventory = stock
			inventoryCapped = stock.count >= Self.inventoryLimit
			cache?.write(stock, Self.inventoryCacheName)
		} catch {
			// Counts stay as they were; the list's own fetch reports connectivity.
		}
	}

	// MARK: Scope and filters

	/// Moves the tab to `scope`, refetching when the server-side filters change.
	public func setScope(_ scope: ObjectsScope) async {
		guard scope != self.scope else { return }
		self.scope = scope
		var type: String?
		var starred = false
		var status = statusFilter
		var search = searchText
		switch effectiveScope {
		case .all, .needsYou, .saved:
			break
		case .favourites:
			starred = true
		case .type(let t):
			type = t
		}
		if case .saved(let id) = scope, let view = savedViews.view(id: id) {
			status = view.statusFilter
			search = view.search
			display.groupBy = view.groupBy
			if view.sort != display.sort { await setSort(view.sort) }
		}
		starredOnly = starred
		let allowed = directory.schema.statuses(for: type)
		if let s = status, !allowed.contains(s) { status = nil }
		let changed = type != typeFilter || status != statusFilter || search != searchText
		typeFilter = type
		statusFilter = status
		searchText = search
		if changed {
			await fetchFirstPage(showSpinner: true)
		} else if starred {
			await loadMore()
		}
	}

	public func setType(_ type: String?) async {
		await setScope(type.map { .type($0) } ?? .all)
	}

	public func setStatus(_ status: String?) async {
		guard status != statusFilter else { return }
		statusFilter = status
		await fetchFirstPage(showSpinner: true)
	}

	public func setStarredOnly(_ on: Bool) async {
		guard on != starredOnly else { return }
		await setScope(on ? .favourites : .all)
	}

	/// Replace the open asks (the For You feed's "needs you" cards).
	public func applyAsks(_ asks: [ObjectAsk]) {
		let next = Dictionary(asks.map { ($0.objectId, $0) }, uniquingKeysWith: { $1 })
		if next != self.asks { self.asks = next }
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

	public func setGrouping(_ grouping: ObjectsGrouping) { display.groupBy = grouping }

	public func toggleGroup(_ id: String) { display.toggleCollapsed(id) }

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

	// MARK: Saved views

	/// Saves the current scope and filters under `name` and switches to the new view.
	@discardableResult
	public func saveCurrentView(named name: String) -> SavedView? {
		let base: ObjectsScope = {
			if case .saved = scope { return effectiveScope }
			return scope
		}()
		let view = SavedView(
			name: name, scope: base, statusFilter: statusFilter, search: searchText,
			groupBy: display.groupBy, sort: display.sort)
		guard !view.name.isEmpty else { return nil }
		savedViews.add(view)
		scope = .saved(view.id)
		return view
	}

	/// Removes a saved view, leaving the list on the view's filters. Returns what `restoreSavedView`
	/// needs to undo it.
	@discardableResult
	public func removeSavedView(_ id: String) -> (view: SavedView, index: Int)? {
		guard let removed = savedViews.remove(id) else { return nil }
		if scope == .saved(id) { scope = removed.view.scope }
		return removed
	}

	public func restoreSavedView(_ view: SavedView, at index: Int) {
		savedViews.restore(view, at: index)
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

	/// Runs until cancelled. Object events refresh the list and the inventory; a reconnect refetches.
	public func observe(_ signals: AsyncStream<HubSignal>) async {
		for await signal in signals {
			if Task.isCancelled { return }
			switch signal {
			case .reconnected:
				async let stock: Void = refreshInventory()
				await refreshInPlace()
				await stock
			case .event(let event) where event.entityType == .object:
				if event.action == "deleted", let id = event.entityId {
					objects.removeAll { $0.id == id }
					inventory.removeAll { $0.id == id }
				} else if phase != .idle {
					async let stock: Void = refreshInventory()
					await refreshInPlace()
					await stock
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
		guard let current = known.first(where: { $0.id == id }) else { return false }
		let starred = !current.isStarred
		mutate(id) { $0.isStarred = starred }
		do {
			try await remote.setStarred(objectId: id, starred: starred)
			actionError = nil
			return true
		} catch {
			mutate(id) { $0.isStarred = !starred }
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

	// MARK: Selection and swipe actions

	/// The statuses every picked object's type offers, in workspace order of the first one. Set
	/// status is only offered what applies to all of them.
	public func commonStatuses(for ids: [String]) -> [String] {
		let types = ids.compactMap { id in objects.first { $0.id == id }?.type }
		guard let first = types.first else { return [] }
		return directory.schema.statuses(for: first).filter { status in
			types.allSatisfy { directory.schema.statuses(for: $0).contains(status) }
		}
	}

	/// Whether every picked object's type has somewhere to archive to.
	public func canArchive(_ ids: [String]) -> Bool {
		let types = ids.compactMap { id in objects.first { $0.id == id }?.type }
		return !types.isEmpty
			&& types.allSatisfy { StatusFlow.archiveTarget(in: directory.schema.statuses(for: $0)) != nil }
	}

	/// Moves each object to its type's archive status (bulk), each its own optimistic write. The
	/// undo holds the ones that landed.
	public func archive(_ ids: [String]) async -> (result: BulkResult, undo: StatusUndo) {
		let moved = await move(ids, action: "archive", past: "archived") { object in
			StatusFlow.archiveTarget(in: self.directory.schema.statuses(for: object.type))
		}
		return moved
	}

	/// Archive one object (swipe). Nil when its type has nowhere to archive to or the write failed.
	public func archive(_ id: String) async -> StatusUndo? {
		let moved = await archive([id])
		return moved.undo.isEmpty ? nil : moved.undo
	}

	/// "Done": the type's first finished status. Nil when it has none or the write failed.
	public func markDone(_ id: String) async -> StatusUndo? {
		let moved = await move([id], action: "update", past: "updated") { object in
			StatusFlow.doneTarget(in: self.directory.schema.statuses(for: object.type))
		}
		return moved.undo.isEmpty ? nil : moved.undo
	}

	/// The status Done would move this object to, or nil to hide the action.
	public func doneTarget(for object: WorkObject) -> String? {
		let target = StatusFlow.doneTarget(in: directory.schema.statuses(for: object.type))
		return target == object.status ? nil : target
	}

	/// Sets each object to `status` (bulk) and remembers where each came from.
	public func setStatusRecording(_ ids: [String], to status: String) async -> (
		result: BulkResult, undo: StatusUndo
	) {
		await move(ids, action: "update", past: "updated") { object in
			self.directory.schema.statuses(for: object.type).contains(status) ? status : nil
		}
	}

	/// Approve: the object's next status per `StatusFlow`. Nil when it has none (nothing happens).
	public func approve(_ id: String) async -> StatusUndo? {
		let moved = await move([id], action: "update", past: "updated") { object in
			StatusFlow.approveTarget(from: object.status, in: self.directory.schema.statuses(for: object.type))
		}
		return moved.undo.isEmpty ? nil : moved.undo
	}

	/// The status Approve would move this object to, or nil to hide the action.
	public func approveTarget(for object: WorkObject) -> String? {
		StatusFlow.approveTarget(from: object.status, in: directory.schema.statuses(for: object.type))
	}

	/// Puts every change in `undo` back. Works for an object the list no longer holds (archived
	/// away by a refresh): the write goes straight to the server and the list reloads.
	@discardableResult
	public func undo(_ undo: StatusUndo) async -> BulkResult {
		var result = BulkResult()
		var missing = false
		for change in undo.changes {
			if known.contains(where: { $0.id == change.id }) {
				if await setStatus(change.id, change.from) { result.succeeded += 1 } else { result.failed += 1 }
			} else {
				missing = true
				do {
					_ = try await remote.update(
						objectId: change.id, patch: ObjectPatch(status: change.from),
						idempotencyKey: IdempotencyKey.make())
					result.succeeded += 1
				} catch {
					result.failed += 1
					actionError = Self.message(error)
				}
			}
		}
		if missing { await refreshInPlace() }
		finish(result, action: "undo", past: "restored")
		return result
	}

	/// Assigns each object to `actorId` (bulk), optimistic with rollback per object.
	@discardableResult
	public func assign(_ ids: [String], to actorId: String) async -> BulkResult {
		var result = BulkResult()
		for id in ids {
			guard let previous = objects.first(where: { $0.id == id }) else { continue }
			guard previous.driverId != actorId else { continue }
			mutate(id) { $0.driverId = actorId }
			do {
				let saved = try await remote.update(
					objectId: id, patch: ObjectPatch(driver: actorId), idempotencyKey: IdempotencyKey.make())
				var merged = saved
				if let now = objects.first(where: { $0.id == id }) { merged.isStarred = now.isStarred }
				apply(merged)
				result.succeeded += 1
			} catch {
				mutate(id) { $0 = previous }
				actionError = Self.message(error)
				result.failed += 1
			}
		}
		finish(result, action: "assign", past: "assigned")
		return result
	}

	private func move(
		_ ids: [String], action: String, past: String, target: (WorkObject) -> String?
	) async -> (result: BulkResult, undo: StatusUndo) {
		var result = BulkResult()
		var changes: [StatusChange] = []
		for id in ids {
			guard let object = known.first(where: { $0.id == id }), let status = target(object),
				status != object.status
			else { continue }
			if await setStatus(id, status) {
				result.succeeded += 1
				changes.append(StatusChange(id: id, from: object.status, to: status))
			} else {
				result.failed += 1
			}
		}
		finish(result, action: action, past: past)
		return (result, StatusUndo(changes: changes))
	}

	/// Optimistic status change with rollback.
	@discardableResult
	public func setStatus(_ id: String, _ status: String) async -> Bool {
		guard let previous = known.first(where: { $0.id == id }), previous.status != status
		else { return false }
		mutate(id) { $0.status = status }
		do {
			let saved = try await remote.update(
				objectId: id, patch: ObjectPatch(status: status), idempotencyKey: IdempotencyKey.make())
			var merged = saved
			if let now = known.first(where: { $0.id == id }) { merged.isStarred = now.isStarred }
			apply(merged)
			actionError = nil
			return true
		} catch {
			mutate(id) { $0 = previous }
			actionError = Self.message(error)
			return false
		}
	}

	/// Optimistic removal with rollback to the same position.
	@discardableResult
	public func delete(_ id: String) async -> Bool {
		guard let index = objects.firstIndex(where: { $0.id == id }) else { return false }
		let removed = objects.remove(at: index)
		let inventoryIndex = inventory.firstIndex { $0.id == id }
		inventory.removeAll { $0.id == id }
		return await commitDelete(removed, index: index, inventoryIndex: inventoryIndex)
	}

	/// Removes the row now but sends the delete only when `hold` has passed, so `undoDelete`
	/// inside that window costs nothing (the server has no undelete).
	public func delete(_ id: String, holdFor hold: Duration) async {
		guard let index = objects.firstIndex(where: { $0.id == id }) ?? inventory.firstIndex(where: { $0.id == id }),
			let removed = known.first(where: { $0.id == id })
		else { return }
		let inventoryIndex = inventory.firstIndex { $0.id == id }
		objects.removeAll { $0.id == id }
		inventory.removeAll { $0.id == id }
		if hold == .zero {
			await commitDelete(removed, index: index, inventoryIndex: inventoryIndex)
			return
		}
		let task = Task { [weak self] in
			try? await Task.sleep(for: hold)
			guard !Task.isCancelled, let self else { return }
			guard let pending = self.pendingDeletes.removeValue(forKey: id) else { return }
			await self.commitDelete(pending.object, index: pending.index, inventoryIndex: pending.inventoryIndex)
		}
		pendingDeletes[id] = PendingDelete(object: removed, index: index, inventoryIndex: inventoryIndex, task: task)
	}

	/// Puts a held delete back before it is sent. `false` once the window has closed.
	@discardableResult
	public func undoDelete(_ id: String) -> Bool {
		guard let pending = pendingDeletes.removeValue(forKey: id) else { return false }
		pending.task.cancel()
		objects.insert(pending.object, at: min(pending.index, objects.count))
		if let i = pending.inventoryIndex { inventory.insert(pending.object, at: min(i, inventory.count)) }
		return true
	}

	@discardableResult
	private func commitDelete(_ removed: WorkObject, index: Int, inventoryIndex: Int?) async -> Bool {
		do {
			try await remote.delete(objectId: removed.id)
			actionError = nil
			return true
		} catch {
			objects.insert(removed, at: min(index, objects.count))
			if let i = inventoryIndex { inventory.insert(removed, at: min(i, inventory.count)) }
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
			if !inventory.contains(where: { $0.id == created.id }) { inventory.insert(created, at: 0) }
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
		if let i = inventory.firstIndex(where: { $0.id == object.id }) { inventory[i] = object }
	}

	public func remove(_ id: String) {
		objects.removeAll { $0.id == id }
		inventory.removeAll { $0.id == id }
	}

	public func clearActionError() { actionError = nil }

	private func mutate(_ id: String, _ change: (inout WorkObject) -> Void) {
		if let i = objects.firstIndex(where: { $0.id == id }) { change(&objects[i]) }
		if let i = inventory.firstIndex(where: { $0.id == id }) { change(&inventory[i]) }
	}

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
