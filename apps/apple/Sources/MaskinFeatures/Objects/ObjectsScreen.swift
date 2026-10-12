import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Objects tab: every insight, bet and task the workspace's people and agents share.
/// A wide single column on every device; a row pushes its detail. Owns its navigation.
public struct ObjectsScreen: View {
	private let environment: AppEnvironment
	private let services: ObjectsServices
	@State private var store: ObjectsStore
	@State private var board: ObjectsBoardStore
	@State private var picking = SelectionModel()
	@State private var path: [ObjectRoute] = []
	@Namespace private var zoom

	public init(environment: AppEnvironment) {
		self.environment = environment
		let services = ObjectsServices(environment: environment)
		self.services = services
		_store = State(
			initialValue: ObjectsStore(
				remote: services.remote, directory: services.directory,
				cache: environment.snapshotCache, displayStorage: UserDefaultsObjectsDisplayStorage()))
		_board = State(initialValue: ObjectsBoardStore(remote: services.remote))
	}

	public var body: some View {
		// One wide column at every width; a row pushes its detail (iPad handoff: no list beside detail).
		stack
		.task(id: environment.workspaceId) {
			store.reset()
			board.reset()
			path = []
			await store.load()
		}
		.task { await store.observe(environment.events.subscribe()) }
		.task { await board.observe(environment.events.subscribe()) }
	}

	/// Search is the list's own `.searchable`; Display holds the filters and grouping.
	private var shellActions: ShellActions {
		ShellActions(
			display: ShellDisplayMenu { ObjectsDisplayMenu(store: store, picking: picking) },
			displaySymbol: ShellActions.slidersSymbol)
	}

	private var stack: some View {
		NavigationStack(path: $path) {
			ObjectsListView(store: store, board: board, selection: nil, zoomNamespace: zoom, picking: picking,
				openObject: { path.append(ObjectRoute(id: $0)) })
				.shellToolbar(environment: environment, title: "Objects", actions: shellActions)
				.navigationDestination(for: ObjectRoute.self) { route in
					detail(route, onOpen: { path.append(ObjectRoute(id: $0)) }, onClose: { path.removeLast() })
					.zoomDestination(id: route.id, in: zoom)
				}
		}
	}

	private func detail(
		_ route: ObjectRoute, onOpen: @escaping (String) -> Void, onClose: @escaping () -> Void
	) -> some View {
		ObjectDetailScreen(
			services: services, objectId: route.id,
			preload: store.objects.first { $0.id == route.id }, listStore: store,
			onOpenObject: onOpen, onClose: onClose,
			decision: ObjectDecisionSection(environment: services.environment, objectId: route.id))
	}
}
