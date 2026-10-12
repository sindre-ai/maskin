import Foundation
import Observation

/// Looks up what an in-app link points at, so a link can show the thing's name and kind instead of
/// its address. An object is fetched once per id and remembered; while it loads, or if it can't be
/// loaded (another workspace, deleted, offline), callers fall back to the kind alone.
@MainActor
@Observable
public final class InternalLinkDirectory {
	public struct Object: Equatable, Sendable {
		public var type: String
		public var title: String?
	}

	public private(set) var objects: [String: Object] = [:]

	@ObservationIgnored private let remote: any ObjectsRemote
	@ObservationIgnored private var requested: Set<String> = []

	public init(remote: any ObjectsRemote) {
		self.remote = remote
	}

	/// The object's type and title once known. The first call for an id starts the lookup and
	/// returns nil; reading `objects` here registers the caller to be told when it arrives.
	public func object(_ id: String) -> Object? {
		if let known = objects[id] { return known }
		if requested.insert(id).inserted {
			Task { await load(id) }
		}
		return nil
	}

	private func load(_ id: String) async {
		guard let graph = try? await remote.graph(objectId: id) else { return }
		let title = graph.object.title?.trimmingCharacters(in: .whitespacesAndNewlines)
		objects[id] = Object(type: graph.object.type, title: title?.isEmpty == false ? title : nil)
	}
}
