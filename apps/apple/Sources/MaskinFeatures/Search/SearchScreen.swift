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

	public init(environment: AppEnvironment, open: ((SearchResult) -> Void)? = nil) {
		self.environment = environment
		self.open = open
	}

	public var body: some View {
		// Keyed on person and workspace so a switch rebuilds the store, its caches and recents.
		SearchScreenContent(environment: environment, open: open)
			.id("\(environment.auth.session?.actorId ?? "")/\(environment.workspaceId ?? "")")
	}
}

private struct SearchScreenContent: View {
	@State private var store: SearchStore
	@State private var path: [SearchRoute] = []
	private let environment: AppEnvironment
	private let open: ((SearchResult) -> Void)?

	init(environment: AppEnvironment, open: ((SearchResult) -> Void)? = nil) {
		let remote = APISearchRemote(
			client: environment.client, credentials: environment.auth.credentialsProvider)
		let auth = environment.auth
		_store = State(
			initialValue: SearchStore(
				remote: remote, recents: SearchRecents(actorId: auth.session?.actorId ?? ""),
				workspaceId: { auth.session?.workspaceId }))
		self.environment = environment
		self.open = open
	}

	var body: some View {
		NavigationStack(path: $path) {
			SearchContentView(store: store, onSelect: select)
				.navigationTitle("Search")
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				#endif
				.searchable(
					text: Binding(get: { store.query }, set: { store.setQuery($0) }),
					prompt: "Search objects, chats, agents, files"
				)
				.searchScopes(Binding(get: { store.scope }, set: { store.scope = $0 })) {
					ForEach(SearchScope.allCases) { scope in Text(scope.title).tag(scope) }
				}
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
