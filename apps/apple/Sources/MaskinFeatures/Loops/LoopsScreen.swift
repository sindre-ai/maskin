import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Flows tab: installed flows of agents. A `NavigationSplitView` — list and detail side by side
/// on iPad and Mac, a push stack on iPhone. Owns its navigation and applies the shell toolbar.
/// Triggers are not here: they open from the profile sheet (or from a flow's detail).
public struct LoopsScreen: View {
	private let environment: AppEnvironment

	public init(environment: AppEnvironment) {
		self.environment = environment
	}

	public var body: some View {
		if let workspaceID = environment.workspaceId {
			// Rebuilt per workspace so nothing from the previous one lingers.
			LoopsContainer(environment: environment, workspaceID: workspaceID)
				.id(workspaceID)
		} else {
			NavigationStack {
				EmptyState(symbol: "arrow.triangle.2.circlepath", title: "Choose a workspace")
					.shellToolbar(environment: environment, title: "Flows")
			}
		}
	}
}

private struct LoopsContainer: View {
	let environment: AppEnvironment
	let workspaceID: String
	@State private var loops: LoopsStore
	@State private var loopSelection: String?
	@State private var triggersRequest: TriggersRequest?
	@State private var search = ""
	@State private var searchPresented = false
	@Namespace private var zoom
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showMarketplace = false

	init(environment: AppEnvironment, workspaceID: String) {
		self.environment = environment
		self.workspaceID = workspaceID
		_loops = State(
			initialValue: LoopsStore(
				api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		NavigationSplitView {
			sidebar
				.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			detail
		}
		.task { await loops.start() }
		.onDisappear { loops.stop() }
		.sheet(item: $triggersRequest) { request in
			TriggersSheet(
				environment: environment, workspaceID: workspaceID, initialSelection: request.triggerID)
		}
		.sheet(isPresented: $showMarketplace) {
			MarketplaceSheet(
				environment: environment, workspaceID: workspaceID,
				onInstalled: { Task { await loops.refresh() } },
				onOpenLoop: { id in
					loopSelection = id
					Task { await loops.refresh() }
				})
		}
	}

	/// Loops are built by describing them in chat, never through a form.
	private func buildLoopInChat() {
		runtime?.buildInChat("I'd like to build a new flow. ")
	}

	private var isLive: Bool { environment.events.connection != .failed }

	private var sidebar: some View {
		LoopsListView(
			store: loops, selection: $loopSelection, search: search, isLive: isLive, zoomNamespace: zoom,
			onNew: { buildLoopInChat() }, onBrowse: { showMarketplace = true }
		)
		.searchable(text: $search, isPresented: $searchPresented, prompt: "Search flows")
		.searchMinimized()
		// Closing the field collapses it back to the icon, so it can't keep a stale query.
		.onChange(of: searchPresented) { if !searchPresented { search = "" } }
		// A flow has no filter yet (flows carry no tags), so the bar is the avatar alone.
		.shellToolbar(environment: environment, title: "Flows")
	}

	@ViewBuilder
	private var detail: some View {
		if let id = loopSelection, let loop = loops.loop(id: id) {
			LoopDetailHost(
				environment: environment, workspaceID: workspaceID, loop: loop,
				directory: loops.directory, list: loops, install: loops.installs[id],
				onOpenTrigger: { triggersRequest = TriggersRequest(triggerID: $0) }
			)
			.id(id)
			.zoomDestination(id: id, in: zoom)
		} else {
			EmptyState(
				symbol: "arrow.triangle.2.circlepath", title: "Select a flow",
				message: "See its steps, what the agents did, and pause or resume it.")
		}
	}
}

/// Asks for the triggers sheet over Flows, opened on one trigger.
private struct TriggersRequest: Identifiable {
	let triggerID: String
	var id: String { triggerID }
}

private struct LoopDetailHost: View {
	@State private var store: LoopDetailStore
	let install: LoopInstall?
	let onOpenTrigger: (String) -> Void

	init(
		environment: AppEnvironment, workspaceID: String, loop: LoopSummary,
		directory: ActorDirectory, list: LoopsStore, install: LoopInstall?,
		onOpenTrigger: @escaping (String) -> Void
	) {
		let detail = LoopDetailStore(
			loop: loop, directory: directory,
			api: APILoopsSource(
				client: environment.client, workspaceID: workspaceID,
				objects: APIObjectsRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider),
				files: APIFilesRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider)),
			events: environment.events)
		detail.onDeleted = { [list] id in list.didDelete(id) }
		_store = State(initialValue: detail)
		self.install = install
		self.onOpenTrigger = onOpenTrigger
	}

	var body: some View {
		if store.isGone {
			EmptyState(symbol: "tray", title: "This flow is gone", message: "It was removed elsewhere.")
		} else {
			LoopDetailView(store: store, install: install, onOpenTrigger: onOpenTrigger)
		}
	}
}
