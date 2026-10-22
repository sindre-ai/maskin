import Foundation
import MaskinAPI
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
	/// The last failed move, cleared by the next successful one.
	public private(set) var moveError: String?

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private var sort: ObjectsSort = .needsYou
	@ObservationIgnored private var generation = 0
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	public init(remote: any ObjectsRemote) { self.remote = remote }

	/// Every status of the type, in workspace order, so a card can be dropped into an empty one.
	/// Only the "no status" column is hidden while it is empty.
	public var shownColumns: [ObjectsBoardColumn] {
		columns.filter { !$0.value.isEmpty || $0.total > 0 }
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

	/// Moves a card to another column: the status changes optimistically (the card jumps columns,
	/// both counts follow) and a failed write puts everything back. Returns what to undo, or nil
	/// when nothing moved (same column, unknown card or column, failed write).
	@discardableResult
	public func move(_ id: String, toColumn value: String) async -> StatusChange? {
		guard let moved = ObjectsBoardMoves.moving(id, to: value, in: columns) else { return nil }
		let before = columns
		columns = moved.columns
		do {
			let saved = try await remote.update(
				objectId: id, patch: ObjectPatch(status: value), idempotencyKey: IdempotencyKey.make())
			moveError = nil
			if let column = columns.firstIndex(where: { $0.value == value }),
				let card = columns[column].objects.firstIndex(where: { $0.id == id })
			{
				columns[column].objects[card] = saved
			}
			return moved.change
		} catch {
			columns = before
			moveError = (error as? ObjectsError)?.message ?? error.localizedDescription
			return nil
		}
	}

	public func clearMoveError() { moveError = nil }

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

/// Pure column arithmetic for a card dropped into another column.
public enum ObjectsBoardMoves {
	/// `columns` with card `id` taken out of its column and put at the top of the column holding
	/// `value`, both totals adjusted, plus the change that undoes it. Nil when the card or the
	/// target column is unknown or they are the same column.
	public static func moving(
		_ id: String, to value: String, in columns: [ObjectsBoardColumn]
	) -> (columns: [ObjectsBoardColumn], change: StatusChange)? {
		guard let from = columns.firstIndex(where: { $0.objects.contains { $0.id == id } }),
			let to = columns.firstIndex(where: { $0.value == value }), from != to,
			let card = columns[from].objects.first(where: { $0.id == id })
		else { return nil }
		var result = columns
		result[from].objects.removeAll { $0.id == id }
		result[from].total = max(0, result[from].total - 1)
		var landed = card
		landed.status = value
		result[to].objects.insert(landed, at: 0)
		result[to].total += 1
		return (result, StatusChange(id: id, from: columns[from].value, to: value))
	}
}
