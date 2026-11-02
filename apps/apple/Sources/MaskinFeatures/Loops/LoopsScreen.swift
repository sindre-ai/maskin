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
	/// A loop link asks for a flow by id; the screen opens it and resets this to nil.
	@Binding private var requestedLoopId: String?

	public init(environment: AppEnvironment, requestedLoopId: Binding<String?> = .constant(nil)) {
		self.environment = environment
		_requestedLoopId = requestedLoopId
	}

	public var body: some View {
		if let workspaceID = environment.workspaceId {
			// Rebuilt per workspace so nothing from the previous one lingers.
			LoopsContainer(environment: environment, workspaceID: workspaceID, requestedLoopId: $requestedLoopId)
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
	@Binding var requestedLoopId: String?
	@State private var loops: LoopsStore
	@State private var loopSelection: String?
	@State private var triggersRequest: TriggersRequest?
	@State private var search = ""
	@State private var searchPresented = false
	@Namespace private var zoom
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showMarketplace = false
	@Environment(\.horizontalSizeClass) private var sizeClass

	init(environment: AppEnvironment, workspaceID: String, requestedLoopId: Binding<String?>) {
		self.environment = environment
		self.workspaceID = workspaceID
		_requestedLoopId = requestedLoopId
		_loops = State(
			initialValue: LoopsStore(
				api: APILoopsSource(
					client: environment.client, workspaceID: workspaceID,
					// The card's latest update reads each flow's graph through the objects remote.
					objects: APIObjectsRemote(
						client: environment.client, credentials: environment.auth.credentialsProvider)),
				events: environment.events, cache: environment.snapshotCache,
				sortStorage: UserDefaultsLoopsSortStorage()))
	}

	var body: some View {
		Group {
			if sizeClass == .regular {
				// Regular width: a 2-3 across card grid; a card pushes the flow full width.
				NavigationStack {
					sidebar
						.navigationDestination(item: $loopSelection) { id in
							pushedDetail(id)
						}
				}
			} else {
				NavigationSplitView {
					sidebar
						.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
				} detail: {
					detail
				}
			}
		}
		.task { await loops.start() }
		// A loop link: open that flow, then clear the request so it fires once.
		.onChange(of: requestedLoopId, initial: true) {
			guard let id = requestedLoopId else { return }
			loopSelection = id
			requestedLoopId = nil
		}
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
			store: loops, selection: $loopSelection, search: search, isLive: isLive, isGrid: sizeClass == .regular, zoomNamespace: zoom,
			onNew: { buildLoopInChat() }
		)
		// Same as Team: the field stays tucked away until the list is pulled down, so the top bar has
		// no search icon.
		.flowsSearch(text: $search, isPresented: $searchPresented)
		// Closing the field can't leave a stale query behind.
		.onChange(of: searchPresented) { if !searchPresented, !search.isEmpty { search = "" } }
		// Flows carry no tags, so there is no filter bar: the one Display item is the sort.
		.shellToolbar(
			environment: environment, title: "Flows",
			actions: ShellActions(display: ShellDisplayMenu { FlowsDisplayMenu(store: loops) }))
	}

	@ViewBuilder
	private func pushedDetail(_ id: String) -> some View {
		if let loop = loops.loop(id: id) {
			LoopDetailHost(
				environment: environment, workspaceID: workspaceID, loop: loop,
				directory: loops.directory, list: loops, install: loops.installs[id],
				onOpenTrigger: { triggersRequest = TriggersRequest(triggerID: $0) }
			)
			.id(id)
		} else {
			EmptyState(symbol: "arrow.triangle.2.circlepath", title: "This flow is gone", message: "It was removed elsewhere.")
		}
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

/// The Flows Display menu in the shell's pill: Recent or Name. Remembered on this device.
struct FlowsDisplayMenu: View {
	@Bindable var store: LoopsStore

	var body: some View {
		Picker("Sort", selection: $store.sort) {
			ForEach(LoopsSort.allCases) { Text($0.title).tag($0) }
		}
	}
}

extension View {
	/// Flows search: a pull-down field, like Team's.
	fileprivate func flowsSearch(text: Binding<String>, isPresented: Binding<Bool>) -> some View {
		#if os(iOS)
			searchable(
				text: text, isPresented: isPresented, placement: .navigationBarDrawer(displayMode: .automatic),
				prompt: "Search flows")
		#else
			searchable(text: text, isPresented: isPresented, prompt: "Search flows")
		#endif
	}
}
