import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

private enum SearchRoute: Hashable {
	case object(String)
	case file(String)
}

/// Full-screen search for the iOS 26 search tab (`Tab(role: .search)`):
///
///     SearchScreen(environment: env) { result in route(result) }
///
/// Tapping a result calls `open`. Without `open`, objects and files push their detail screens
/// here; chats and agents have no screen of their own in this package, so they are inert until
/// the shell supplies `open`.
public struct SearchScreen: View {
	private let environment: AppEnvironment
	private let open: ((SearchResult) -> Void)?
	private let onNewItem: ((String) -> Void)?

	/// `onNewItem` starts a new item with the typed words as its title; without it the quick
	/// search's Create list has no New item row.
	public init(
		environment: AppEnvironment, open: ((SearchResult) -> Void)? = nil, onNewItem: ((String) -> Void)? = nil
	) {
		self.environment = environment
		self.open = open
		self.onNewItem = onNewItem
	}

	public var body: some View {
		// Keyed on person and workspace so a switch rebuilds the store, its caches and recents.
		SearchScreenContent(environment: environment, open: open, onNewItem: onNewItem)
			.id("\(environment.auth.session?.actorId ?? "")/\(environment.workspaceId ?? "")")
	}
}

private struct SearchScreenContent: View {
	@State private var store: SearchStore
	@State private var rowActions: SearchRowActions
	@State private var path: [SearchRoute] = []
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	private let environment: AppEnvironment
	private let open: ((SearchResult) -> Void)?
	private let onNewItem: ((String) -> Void)?

	init(environment: AppEnvironment, open: ((SearchResult) -> Void)? = nil, onNewItem: ((String) -> Void)? = nil) {
		self.onNewItem = onNewItem
		let remote = APISearchRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider)
		let auth = environment.auth
		let searchStore = SearchStore(
			remote: remote, recents: SearchRecents(actorId: auth.session?.actorId ?? ""),
			workspaceId: { auth.session?.workspaceId }, currentActorId: { auth.session?.actorId })
		_store = State(initialValue: searchStore)
		// The long-press menus act on a chat list and an object list of their own (see SearchRowActions).
		let workspaceID = environment.workspaceId ?? ""
		let services = ObjectsServices(environment: environment)
		let objects = ObjectsStore(remote: services.remote, directory: services.directory)
		objects.bindWorkspace(environment.workspaceId)
		let chats = ConversationsStore(
			api: APIChatsSource(client: environment.client, workspaceID: workspaceID), events: nil,
			preferences: TeamPreferences(actorID: auth.session?.actorId, workspaceID: workspaceID))
		_rowActions = State(initialValue: SearchRowActions(search: searchStore, chats: chats, objects: objects))
		self.environment = environment
		self.open = open
	}

	var body: some View {
		NavigationStack(path: $path) {
			SearchContentView(
				store: store, needsYou: needsYou, onOpenNeedsYou: { runtime?.openObject($0) },
				onAskChiefOfStaff: askChiefOfStaff, onCreate: create, createKinds: onNewItem == nil ? [.flow, .chat] : [.item, .flow, .chat],
				rowMenu: { AnyView(rowActions.menu(for: $0)) }, onSelect: select
			)
				.undoToast(Binding(get: { rowActions.undoOffer }, set: { rowActions.undoOffer = $0 }))
				.confirmationDialog(
					"Delete this conversation?",
					isPresented: Binding(
						get: { rowActions.deleteTarget != nil }, set: { if !$0 { rowActions.deleteTarget = nil } }),
					titleVisibility: .visible, presenting: rowActions.deleteTarget
				) { target in
					Button("Delete", role: .destructive) {
						MaskinHaptics.play(.warning)
						rowActions.delete(target)
					}
				} message: { _ in
					Text("It disappears from your chats. This can't be undone.")
				}
				.shellToolbar(environment: environment, title: "Search")
				.searchable(
					text: Binding(get: { store.query }, set: { store.setQuery($0) }),
					prompt: "Search"
				)
				.onSubmit(of: .search) { Task { await store.commit() } }
				.navigationDestination(for: SearchRoute.self) { route in
					switch route {
					case .object(let id):
						ObjectDetailScreen(environment: environment, objectId: id) { EmptyView() }
					case .file(let id):
						FileScreen(environment: environment, fileId: id)
					}
				}
		}
		.onAppear {
			store.reloadRecents()
			store.expireStaleDirectories()
			rowActions.open = select
		}
		// The menus need the rows of what was found: read them once the results are in.
		.task(id: store.phase == .results ? store.query : "") {
			let words = store.query.trimmingCharacters(in: .whitespacesAndNewlines)
			if store.phase == .results, !words.isEmpty { await rowActions.load(query: words) }
		}
	}

	/// The decisions waiting on the person (For you's "Needs you"), as plain rows.
	private var needsYou: [SearchNeedsYou] {
		guard let runtime else { return [] }
		return runtime.forYou.store.entries.filter { $0.bucket == .needs }.prefix(4).map {
			SearchNeedsYou(
				id: $0.card.id, title: $0.card.headline,
				type: $0.card.objectType?.replacingOccurrences(of: "_", with: " "))
		}
	}

	/// Hands the query to a new chat (the same draft route the flow and agent builders use); the
	/// person picks Chief of Staff there.
	private func askChiefOfStaff(_ query: String) {
		runtime?.buildInChat("Can you look into “\(query)”? ")
	}

	/// A new chat, or a flow set up with the Chief of Staff, starting from what was typed.
	private func create(_ kind: SearchCreate, _ query: String) {
		switch kind {
		case .item: onNewItem?(query)
		case .chat: runtime?.requestNewConversation()
		case .flow: runtime?.buildInChat("I'd like a new flow about “\(query)”. ")
		}
	}

	private func select(_ result: SearchResult) {
		store.didOpen(result)
		if let open {
			open(result)
			return
		}
		switch result.kind {
		case .object: path.append(.object(result.entityId))
		case .file: path.append(.file(result.entityId))
		case .chat, .agent: break
		}
	}
}
