import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Objects tab: every object the workspace's people and agents share, by type and status.
/// A wide single column on every device; a row pushes its detail. Owns its navigation.
public struct ObjectsScreen: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	private let environment: AppEnvironment
	private let services: ObjectsServices
	@State private var store: ObjectsStore
	@State private var board: ObjectsBoardStore
	@State private var picking = SelectionModel()
	@State private var intents = ObjectsListIntents()
	@State private var path: [ObjectRoute] = []
	@Namespace private var zoom
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

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

	/// The For You feed: where open asks come from, and where answers go.
	private var feed: ForYouStore? { runtime?.forYou.store }

	public var body: some View {
		// One wide column at every width; a row pushes its detail (iPad handoff: no list beside detail).
		stack
		.task(id: environment.workspaceId) {
			store.reset()
			board.reset()
			path = []
			store.bindWorkspace(environment.workspaceId)
			await store.load()
		}
		.task { await store.observe(environment.events.subscribe()) }
		.task { await board.observe(environment.events.subscribe()) }
		.task {
			if let feed, feed.phase == .idle { await feed.load() }
		}
		.onChange(of: feed?.entries, initial: true) { _, entries in
			guard let feed else { return }
			store.applyAsks((entries ?? []).compactMap { ObjectAsk($0, senderName: feed.senderName(of: $0.card)) })
		}
	}

	/// The title lives in the content (tap it for Go to); the pill holds Display and the avatar.
	/// The Objects page has no search field in its top bar.
	private var shellActions: ShellActions {
		ShellActions(
			display: ShellDisplayMenu { ObjectsDisplayMenu(store: store, picking: picking, intents: intents) },
			displaySymbol: ShellActions.slidersSymbol,
			displayActive: store.display.isCustomised || store.statusFilter != nil,
			hidesAvatar: true)
	}

	// MARK: Asks

	/// Approve / Hold on a row go through the feed's `DecisionService`, so the receipt, Undo and
	/// queued state match what For You shows.
	private var askActions: ObjectAskActions {
		var actions = ObjectAskActions()
		actions.approve = { ask in
			guard let feed, let entry = feed.entries.first(where: { $0.id == ask.objectId }) else { return }
			withAnimation(reduceMotion ? nil : MaskinMotion.standard) {
				if let option = ask.approveOption {
					feed.choose(option, on: entry.card)
				} else {
					feed.reply("Approved", on: entry.card)
				}
			}
		}
		actions.hold = { ask, reason in
			guard let feed, let entry = feed.entries.first(where: { $0.id == ask.objectId }) else { return }
			withAnimation(reduceMotion ? nil : MaskinMotion.standard) {
				if let reason, !reason.isEmpty {
					feed.reply("Hold: \(reason)", on: entry.card)
				} else if let option = ask.holdOption {
					feed.choose(option, on: entry.card)
				} else {
					feed.reply("Hold", on: entry.card)
				}
			}
		}
		actions.undo = { ask in
			guard let feed, let entry = feed.entries.first(where: { $0.id == ask.objectId }) else { return }
			withAnimation(reduceMotion ? nil : MaskinMotion.standard) { _ = feed.undo(entry.card) }
		}
		return actions
	}

	private var stack: some View {
		NavigationStack(path: $path) {
			ObjectsListView(
				store: store, board: board, selection: nil, zoomNamespace: zoom, picking: picking, intents: intents,
				askActions: askActions, onOpen: { path.append(ObjectRoute(id: $0)) })
				.shellToolbar(environment: environment, title: nil, actions: shellActions)
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
		// Arrow-only back button on anything pushed from here (object → object).
		.backChevronOnly()
	}
}
