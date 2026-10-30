import MaskinAPI
import MaskinCore
import MaskinUI
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
		let remote = APIObjectsRemote(
			client: environment.client, credentials: credentials, baseURL: environment.baseURL,
			clientSource: environment.clientSource)
		// Loops and triggers come from the same lists the Flows and Triggers screens read.
		let loops = APILoopsSource(client: environment.client, workspaceID: workspaceId)
		let triggers = APITriggersSource(client: environment.client, workspaceID: workspaceId)
		let store = LinkedItemStore(
			objects: remote,
			files: APIFilesRemote(client: environment.client, credentials: credentials),
			actors: { try await remote.actors() },
			places: APILinkedPlacesRemote(client: environment.client, workspaceID: workspaceId),
			loops: { try await loops.loops() },
			triggers: { try await triggers.listPage() },
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
	/// The card sits inside a message bubble, where its summary is one line (stand-alone it is two).
	@Entry var linkedInBubble: Bool = false
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
		case .loop: runtime?.openLoop(target.uuid)
		case .trigger: runtime?.openTrigger(target.uuid)
		case .agent: runtime?.openAgent(target.uuid)
		case .chat: runtime?.openChat(target.uuid)
		}
	}

	/// Closes the sheet the caller is in, waits for it to finish, then opens the target: the shell
	/// presents from above everything and cannot while a sheet is up.
	static func openAfterClosing(_ target: LinkedTarget, close: () -> Void, runtime: AppRuntime?) {
		close()
		Task {
			try? await Task.sleep(for: .milliseconds(450))
			switch target.kind {
			case .object: runtime?.openObject(target.uuid)
			case .file: runtime?.openFile(target.uuid)
			case .loop: runtime?.openLoop(target.uuid)
			case .trigger: runtime?.openTrigger(target.uuid)
			case .agent: runtime?.openAgent(target.uuid)
			case .chat: runtime?.openChat(target.uuid)
			}
		}
	}
}

extension LinkedItemStores {
	/// How a link that stands alone on its line is drawn outside a chat message (a comment, a
	/// description): the card face for an object or page the store can show, the thin card for the
	/// rest. Drafts keep their approval card to chat, where the agent is told of a yes.
	static func standaloneStyle(for url: URL, environment: AppEnvironment) -> MarkdownStandaloneLinkStyle {
		guard let target = LinkedTarget.parse(href: url.absoluteString), let store = store(for: environment) else {
			return .simple
		}
		if store.state(for: target) == nil { Task { await store.resolve([target]) } }
		if case .draft? = store.item(for: target) { return .simple }
		// A person at an agent address is a plain link.
		guard store.showsCard(target) else {
			return target.kind == .agent && store.state(for: target) == .unavailable ? .inline : .simple
		}
		return .card(AnyView(LinkedTargetCard(target: target).environment(\.linkedItems, store)))
	}
}
