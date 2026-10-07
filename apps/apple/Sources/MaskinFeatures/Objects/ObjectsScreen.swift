import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Objects tab: every insight, bet and task the workspace's people and agents share.
/// iPhone: list pushes detail. iPad / Mac: list beside detail. Owns its navigation.
public struct ObjectsScreen: View {
	private let environment: AppEnvironment
	private let services: ObjectsServices
	@State private var store: ObjectsStore
	@State private var path: [ObjectRoute] = []
	@Namespace private var zoom
	@State private var selection: String?
	@State private var detailPath: [ObjectRoute] = []
	@Environment(\.horizontalSizeClass) private var sizeClass

	public init(environment: AppEnvironment) {
		self.environment = environment
		let services = ObjectsServices(environment: environment)
		self.services = services
		_store = State(
			initialValue: ObjectsStore(
				remote: services.remote, directory: services.directory,
				cache: environment.snapshotCache))
	}

	public var body: some View {
		Group {
			if sizeClass == .compact {
				stack
			} else {
				split
			}
		}
		.task(id: environment.workspaceId) {
			store.reset()
			path = []
			selection = nil
			await store.load()
		}
		.task { await store.observe(environment.events.subscribe()) }
	}

	/// Search is the list's own `.searchable`; Display holds the filters and grouping.
	private var shellActions: ShellActions {
		ShellActions(search: false, display: ShellDisplayMenu { ObjectsDisplayMenu(store: store) })
	}

	// MARK: iPhone

	private var stack: some View {
		NavigationStack(path: $path) {
			ObjectsListView(store: store, selection: nil, zoomNamespace: zoom)
				.shellToolbar(environment: environment, title: "Objects", actions: shellActions)
				.navigationDestination(for: ObjectRoute.self) { route in
					detail(route, onOpen: { path.append(ObjectRoute(id: $0)) }, onClose: { path.removeLast() })
					.zoomDestination(id: route.id, in: zoom)
				}
		}
	}

	// MARK: iPad / Mac

	private var split: some View {
		NavigationSplitView {
			ObjectsListView(store: store, selection: $selection)
				.shellToolbar(environment: environment, title: "Objects", actions: shellActions)
				.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			NavigationStack(path: $detailPath) {
				if let selection {
					detail(
						ObjectRoute(id: selection), onOpen: { detailPath.append(ObjectRoute(id: $0)) },
						onClose: { self.selection = nil })
						.id(selection)
						.navigationDestination(for: ObjectRoute.self) { route in
							detail(
								route, onOpen: { detailPath.append(ObjectRoute(id: $0)) },
								onClose: { detailPath.removeLast() })
						}
				} else {
					EmptyState(
						symbol: "square.stack.3d.up", title: "Select an object",
						message: "Pick an insight, bet or task to read it and join the conversation.")
				}
			}
		}
		.onChange(of: selection) { _, _ in detailPath = [] }
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
