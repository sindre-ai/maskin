import MaskinAPI
import MaskinCore
import SwiftUI

extension EnvironmentValues {
	/// What the links in chat messages resolve to. Nil in previews and tests: messages then render
	/// exactly as plain markdown.
	@Entry var linkedItems: LinkedItemStore? = nil
}

/// One store per account and workspace, so a chat reopened a moment later still has its cards
/// (no flash of plain links) and a different account never sees another's.
@MainActor
enum LinkedItemStores {
	private static var cache: [String: LinkedItemStore] = [:]
	private static var cachedActor: String?

	static func store(for environment: AppEnvironment) -> LinkedItemStore? {
		guard let workspaceId = environment.workspaceId else { return nil }
		let actor = environment.auth.session?.actorId
		// Another account signed in: nothing resolved for the last one is kept.
		if actor != cachedActor {
			cache.removeAll()
			cachedActor = actor
		}
		let key = workspaceId
		if let held = cache[key] { return held }
		let credentials = environment.auth.credentialsProvider
		let store = LinkedItemStore(
			objects: APIObjectsRemote(
				client: environment.client, credentials: credentials, baseURL: environment.baseURL,
				clientSource: environment.clientSource),
			files: APIFilesRemote(client: environment.client, credentials: credentials),
			workspaceID: { [weak environment] in environment?.workspaceId })
		cache[key] = store
		return store
	}
}

extension View {
	/// Gives the messages below the shared link store of the signed-in workspace.
	func linkedItems(_ runtime: AppRuntime?) -> some View {
		environment(\.linkedItems, runtime.flatMap { LinkedItemStores.store(for: $0.environment) })
	}
}

extension EnvironmentValues {
	/// How a card opens its object or file. The Linked sheet sets it to close itself first: the
	/// shell presents objects and files from above everything, and cannot while a sheet is up.
	@Entry var linkedOpen: ((LinkedTarget) -> Void)? = nil
}

/// Opens a linked object or file the way the surrounding screen wants (see `linkedOpen`).
@MainActor
struct LinkedOpener: DynamicProperty {
	@Environment(\.linkedOpen) private var custom
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	func callAsFunction(_ target: LinkedTarget) {
		if let custom {
			custom(target)
			return
		}
		switch target.kind {
		case .object: runtime?.openObject(target.uuid)
		case .file: runtime?.openFile(target.uuid)
		}
	}
}
