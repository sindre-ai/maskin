import Foundation
import Observation

/// A saved view: the Objects tab's current scope, status filter, search, grouping and sort under
/// a name of the reader's choosing. The API has no saved views, so these live on the device, per
/// workspace, in `UserDefaults`.
public struct SavedView: Identifiable, Sendable, Equatable, Codable {
	public var id: String
	public var name: String
	/// What the view narrows to. Never `.saved` itself.
	public var scope: ObjectsScope
	public var statusFilter: String?
	public var search: String
	public var groupBy: ObjectsGrouping
	public var sort: ObjectsSort

	public init(
		id: String = UUID().uuidString, name: String, scope: ObjectsScope, statusFilter: String? = nil,
		search: String = "", groupBy: ObjectsGrouping = .status, sort: ObjectsSort = .needsYou
	) {
		self.id = id
		self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
		self.scope = scope
		self.statusFilter = statusFilter
		self.search = search
		self.groupBy = groupBy
		self.sort = sort
	}

	/// Does `object` belong in this view? Used for the live count beside the view's name; the
	/// list itself is fetched with the view's filters.
	public func matches(_ object: WorkObject, needsYou: Bool) -> Bool {
		switch scope {
		case .needsYou: if !needsYou { return false }
		case .favourites: if !object.isStarred { return false }
		case .type(let type): if object.type != type { return false }
		case .all, .saved: break
		}
		if let statusFilter, object.status != statusFilter { return false }
		if !search.isEmpty, !object.displayTitle.localizedCaseInsensitiveContains(search) { return false }
		return true
	}
}

/// The reader's saved views for one workspace. Persists on every change; `remove` returns the
/// view so an Undo can `restore` it to the same slot.
@MainActor
@Observable
public final class SavedViewsStore {
	public private(set) var views: [SavedView] = []

	@ObservationIgnored private let defaults: UserDefaults
	@ObservationIgnored private var key: String?

	public init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	/// Switches to `workspaceId`'s views (loading them); `nil` clears the list.
	public func bind(workspaceId: String?) {
		let newKey = workspaceId.map { "objects.savedViews.v1.\($0)" }
		guard newKey != key else { return }
		key = newKey
		views = newKey.flatMap { key -> [SavedView]? in
			guard let data = defaults.data(forKey: key) else { return nil }
			return try? JSONDecoder().decode([SavedView].self, from: data)
		} ?? []
	}

	public func view(id: String) -> SavedView? { views.first { $0.id == id } }

	public func name(of id: String) -> String? { view(id: id)?.name }

	public func add(_ view: SavedView) {
		guard !view.name.isEmpty else { return }
		views.removeAll { $0.id == view.id }
		views.append(view)
		persist()
	}

	public func rename(_ id: String, to name: String) {
		guard let i = views.firstIndex(where: { $0.id == id }) else { return }
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		views[i].name = trimmed
		persist()
	}

	/// Removes the view and returns it with its position, for Undo.
	@discardableResult
	public func remove(_ id: String) -> (view: SavedView, index: Int)? {
		guard let i = views.firstIndex(where: { $0.id == id }) else { return nil }
		let removed = views.remove(at: i)
		persist()
		return (removed, i)
	}

	public func restore(_ view: SavedView, at index: Int) {
		guard !views.contains(where: { $0.id == view.id }) else { return }
		views.insert(view, at: min(index, views.count))
		persist()
	}

	private func persist() {
		guard let key else { return }
		if let data = try? JSONEncoder().encode(views) {
			defaults.set(data, forKey: key)
		}
	}
}
