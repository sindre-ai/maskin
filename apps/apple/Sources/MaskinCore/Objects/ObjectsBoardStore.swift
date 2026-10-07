import Foundation
import Observation

/// The Objects board: one type's objects in a column per status, read from `GET /objects/board`.
/// The list store keeps owning filters, writes and the detail screens; this only reads columns.
@MainActor
@Observable
public final class ObjectsBoardStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	/// Cards fetched per column per request.
	public static let pageSize = 20

	public private(set) var columns: [ObjectsBoardColumn] = []
	public private(set) var phase: Phase = .idle
	public private(set) var isOffline = false
	/// Column ids a "more" request is in flight for.
	public private(set) var loadingMore: Set<String> = []
	public private(set) var type: String?

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private var sort: ObjectsSort = .needsYou
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	public init(remote: any ObjectsRemote) { self.remote = remote }

	/// Columns worth showing: the ones holding something (every column when the type is empty, so
	/// the board still reads as a workflow).
	public var shownColumns: [ObjectsBoardColumn] {
		let filled = columns.filter { $0.total > 0 }
		return filled.isEmpty ? columns : filled
	}

	/// The cards of a column in the chosen order, narrowed to what needs the person when asked.
	public func cards(in column: ObjectsBoardColumn, needsYouOnly: Bool) -> [WorkObject] {
		let sorted = ObjectsSorter.sorted(column.objects, by: sort)
		return needsYouOnly ? sorted.filter(ObjectsUrgency.needsYou) : sorted
	}

	/// The count a column header shows: the server total, or what is loaded and needs the person.
	public func count(in column: ObjectsBoardColumn, needsYouOnly: Bool) -> Int {
		needsYouOnly ? column.objects.filter(ObjectsUrgency.needsYou).count : column.total
	}

	public func reset() {
		generation += 1
		columns = []
		phase = .idle
		type = nil
		isOffline = false
		loadingMore = []
	}

	/// Load `type`'s board. A different type (or first load) shows the spinner; the same type
	/// refreshes quietly and a failure keeps what is on screen.
	public func load(type newType: String?, sort newSort: ObjectsSort) async {
		sort = newSort
		guard let newType else {
			reset()
			return
		}
		if newType != type {
			generation += 1
			columns = []
			phase = .loading
			loadingMore = []
			type = newType
		}
		await refresh()
	}

	public func refresh() async {
		guard type != nil else { return }
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			guard let type else { return }
			let mine = generation
			// Keep as many cards per column as are already shown, so a refresh doesn't snap back.
			let shown = columns.map(\.objects.count).max() ?? 0
			do {
				let fresh = try await remote.board(
					ObjectsBoardQuery(
						type: type, sort: sort, limit: min(max(Self.pageSize, shown), ServerLimits.maxPageSize)))
				guard mine == generation else { continue }
				columns = fresh
				phase = .loaded
				isOffline = false
			} catch {
				guard mine == generation else { continue }
				isOffline = (error as? ObjectsError)?.isOffline ?? false
				if columns.isEmpty { phase = .failed(ObjectsStore.message(error)) }
			}
		} while refreshQueued
	}

	/// Pages one column on.
	public func loadMore(column id: String) async {
		guard let type, let index = columns.firstIndex(where: { $0.id == id }),
			columns[index].hasMore, !loadingMore.contains(id)
		else { return }
		loadingMore.insert(id)
		defer { loadingMore.remove(id) }
		let mine = generation
		let current = columns[index]
		do {
			let page = try await remote.board(
				ObjectsBoardQuery(
					type: type, column: current.value, sort: sort, limit: Self.pageSize,
					offset: current.objects.count))
			guard mine == generation, let now = columns.firstIndex(where: { $0.id == id }) else { return }
			let known = Set(columns[now].objects.map(\.id))
			let more = page.first { $0.id == id }
			columns[now].objects += (more?.objects ?? []).filter { !known.contains($0.id) }
			if let total = more?.total { columns[now].total = total }
		} catch {
			guard mine == generation else { return }
			isOffline = (error as? ObjectsError)?.isOffline ?? false
		}
	}

	/// Runs until cancelled: object events and reconnects refetch the board.
	public func observe(_ signals: AsyncStream<HubSignal>) async {
		for await signal in signals {
			if Task.isCancelled { return }
			switch signal {
			case .reconnected:
				await refresh()
			case .event(let event) where event.entityType == .object:
				if phase != .idle { await refresh() }
			default:
				break
			}
		}
	}
}
