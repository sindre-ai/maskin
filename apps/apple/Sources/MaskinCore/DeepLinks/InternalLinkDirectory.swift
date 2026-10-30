import Foundation
import Observation

/// Tells an in-app link what it points at, so a link can show the thing's name and kind instead of
/// its address. It reads the same record as the card, from the shared `LinkedItemStore`: an object is
/// looked up once per id for the card, the link and the Linked sheet together. While it loads, or if
/// it can't be loaded (another workspace, offline), callers fall back to the kind alone.
@MainActor
@Observable
public final class InternalLinkDirectory {
	public struct Object: Equatable, Sendable {
		public var type: String
		public var title: String?
		/// Nil when the object has no status.
		public var status: String?
	}

	/// How far the lookup of one object got.
	public enum Lookup: Equatable, Sendable {
		case object(Object)
		/// Not asked yet, or asked and waiting.
		case loading
		/// The object is gone (the lookup cannot tell gone from private, and nothing is private).
		case deleted
		/// Not a thing the directory can name: no store yet, a failed lookup, or a file.
		case unreadable
	}

	@ObservationIgnored private let store: @MainActor () -> LinkedItemStore?

	/// `store` is read each time, since the shared store belongs to the signed-in workspace.
	public init(store: @escaping @MainActor () -> LinkedItemStore?) {
		self.store = store
	}

	/// The object's type, title and status once known. The first call for an id starts the lookup and
	/// returns nil; reading the store here registers the caller to be told when it arrives.
	/// `workspace` is the one the link's address names: an object in another workspace is not
	/// looked up.
	public func object(_ id: String, workspace: String? = nil) -> Object? {
		if case .object(let object) = lookup(id, workspace: workspace) { return object }
		return nil
	}

	/// Where the lookup of this object stands. The first call for an id starts it.
	public func lookup(_ id: String, workspace: String? = nil) -> Lookup {
		guard let store = store() else { return .unreadable }
		let target = LinkedTarget(kind: .object, uuid: id, workspaceID: workspace)
		switch store.state(for: target) {
		case nil:
			Task { await store.resolve([target]) }
			return .loading
		case .ready(let item)?:
			switch item {
			case .object(let object):
				return .object(Object(type: object.type, title: object.title, status: Self.title(object.status)))
			case .draft(let object, _):
				return .object(
					Object(type: object.type, title: Self.title(object.title), status: Self.title(object.status)))
			case .deleted: return .deleted
			case .file, .plain, .otherWorkspace: return .unreadable
			}
		case .loading?:
			return .loading
		case .unavailable?:
			return .unreadable
		}
	}

	private static func title(_ text: String?) -> String? {
		let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed?.isEmpty == false ? trimmed : nil
	}
}
