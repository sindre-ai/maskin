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
	public func object(_ id: String) -> Object? {
		if case .object(let object) = lookup(id) { return object }
		return nil
	}

	/// Where the lookup of this object stands. The first call for an id starts it.
	public func lookup(_ id: String) -> Lookup {
		guard let store = store() else { return .unreadable }
		let target = LinkedTarget(kind: .object, uuid: id)
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
			case .file, .plain, .loop, .trigger, .agent, .chat, .chatUnavailable: return .unreadable
			}
		case .loading?:
			return .loading
		case .unavailable?:
			return .unreadable
		}
	}

	/// What a link to a loop or a trigger turned out to be.
	public struct Named: Equatable, Sendable {
		/// The loop's or trigger's own name; nil for a deleted one.
		public var title: String?
		public var isDeleted: Bool
	}

	/// The name of a loop or trigger once known, or that it was deleted. The first call for an id
	/// starts the lookup and returns nil; while it loads, or if it can't be read (offline, a trigger
	/// the triggers list does not hold), callers fall back to the kind alone.
	public func named(_ kind: LinkedTarget.Kind, id: String) -> Named? {
		guard kind == .loop || kind == .trigger, let store = store() else { return nil }
		let target = LinkedTarget(kind: kind, uuid: id)
		switch store.state(for: target) {
		case nil:
			Task { await store.resolve([target]) }
			return nil
		case .ready(let item)?:
			switch item {
			case .loop(let loop): return Named(title: loop.displayName, isDeleted: false)
			case .trigger(let trigger): return Named(title: trigger.displayName, isDeleted: false)
			case .deleted: return Named(title: nil, isDeleted: true)
			case .draft, .file, .object, .plain, .agent, .chat, .chatUnavailable: return nil
			}
		case .loading?, .unavailable?:
			return nil
		}
	}

	private static func title(_ text: String?) -> String? {
		let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed?.isEmpty == false ? trimmed : nil
	}
}
