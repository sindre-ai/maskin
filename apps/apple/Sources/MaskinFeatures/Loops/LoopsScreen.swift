import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Loops tab: installed pipelines of agents, and the triggers that wake them. A
/// `NavigationSplitView` — list and detail side by side on iPad and Mac, a push stack on iPhone —
/// with a Loops | Triggers switch above the list. Owns its navigation and applies the shell toolbar.
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
					.navigationTitle("Loops")
					.shellToolbar(environment: environment)
			}
		}
	}
}

enum AutomationMode: String, CaseIterable, Identifiable {
	case loops = "Loops"
	case triggers = "Triggers"
	var id: String { rawValue }
}

private struct LoopsContainer: View {
	let environment: AppEnvironment
	let workspaceID: String
	@State private var loops: LoopsStore
	@State private var triggers: TriggersStore
	@State private var mode: AutomationMode = .loops
	@State private var loopSelection: String?
	@State private var triggerSelection: String?
	@State private var search = ""
	@State private var showNewTrigger = false
	@State private var showNewLoop = false
	@State private var showMarketplace = false

	init(environment: AppEnvironment, workspaceID: String) {
		self.environment = environment
		self.workspaceID = workspaceID
		_loops = State(
			initialValue: LoopsStore(
				api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
		_triggers = State(
			initialValue: TriggersStore(
				api: APITriggersSource(client: environment.client, workspaceID: workspaceID),
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
		.task { await triggers.start() }
		.onDisappear {
			loops.stop()
			triggers.stop()
		}
		.sheet(isPresented: $showNewTrigger) {
			NewTriggerSheet(store: triggers) { created in
				mode = .triggers
				triggerSelection = created.id
			}
		}
		.sheet(isPresented: $showNewLoop) {
			NewLoopSheet(store: loops) { id in
				mode = .loops
				loopSelection = id
			}
		}
		.sheet(isPresented: $showMarketplace) {
			MarketplaceSheet(
				environment: environment, workspaceID: workspaceID,
				onInstalled: { Task { await loops.refresh() } },
				onOpenLoop: { id in
					mode = .loops
					loopSelection = id
					Task { await loops.refresh() }
				})
		}
	}

	private var isLive: Bool { environment.events.connection != .failed }

	@ViewBuilder
	private var sidebar: some View {
		Group {
			switch mode {
			case .loops:
				LoopsListView(
					store: loops, selection: $loopSelection, search: search, isLive: isLive,
					onNew: { showNewLoop = true }, onBrowse: { showMarketplace = true })
			case .triggers:
				TriggersListView(
					store: triggers, selection: $triggerSelection, search: search, isLive: isLive,
					onNew: { showNewTrigger = true })
			}
		}
		.safeAreaInset(edge: .top, spacing: 0) {
			Picker("Show", selection: $mode) {
				ForEach(AutomationMode.allCases) { Text($0.rawValue).tag($0) }
			}
			.pickerStyle(.segmented)
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s4)
			.background(.bar)
		}
		.searchable(text: $search, prompt: mode == .loops ? "Search loops" : "Search triggers")
		.navigationTitle(mode.rawValue)
		.toolbar {
			if mode == .loops {
				ToolbarItem(placement: .automatic) {
					Menu {
						Button { showNewLoop = true } label: { Label("New loop", systemImage: "plus") }
						Button { showMarketplace = true } label: {
							Label("Browse marketplace", systemImage: "square.grid.2x2")
						}
					} label: {
						Label("Add loop", systemImage: "plus")
					}
				}
			}
			if mode == .triggers {
				ToolbarItem(placement: .automatic) {
					Button { showNewTrigger = true } label: { Label("New schedule", systemImage: "plus") }
				}
			}
		}
		.shellToolbar(environment: environment)
	}

	@ViewBuilder
	private var detail: some View {
		switch mode {
		case .loops:
			if let id = loopSelection, let loop = loops.loop(id: id) {
				LoopDetailHost(
					environment: environment, workspaceID: workspaceID, loop: loop,
					directory: loops.directory, list: loops, install: loops.installs[id],
					onOpenTrigger: { triggerID in
						mode = .triggers
						triggerSelection = triggerID
					}
				)
				.id(id)
			} else {
				EmptyState(
					symbol: "arrow.triangle.2.circlepath", title: "Select a loop",
					message: "See its steps, what the agents did, and pause or resume it.")
			}
		case .triggers:
			if let id = triggerSelection, let trigger = triggers.trigger(id: id) {
				TriggerDetailHost(
					environment: environment, workspaceID: workspaceID, trigger: trigger, list: triggers,
					onGone: { triggerSelection = nil }
				)
				.id(id)
			} else {
				EmptyState(
					symbol: "bolt", title: "Select a trigger",
					message: "Turn it on or off, change its schedule, or create a new one.")
			}
		}
	}
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
			api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events)
		detail.onDeleted = { [list] id in list.didDelete(id) }
		_store = State(initialValue: detail)
		self.install = install
		self.onOpenTrigger = onOpenTrigger
	}

	var body: some View {
		if store.isGone {
			EmptyState(symbol: "tray", title: "This loop is gone", message: "It was removed elsewhere.")
		} else {
			LoopDetailView(store: store, install: install, onOpenTrigger: onOpenTrigger)
		}
	}
}

private struct TriggerDetailHost: View {
	@State private var store: TriggerDetailStore
	let onGone: () -> Void

	init(
		environment: AppEnvironment, workspaceID: String, trigger: Trigger, list: TriggersStore,
		onGone: @escaping () -> Void
	) {
		let detail = TriggerDetailStore(
			trigger: trigger, directory: list.directory,
			api: APITriggersSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events)
		detail.onSaved = { [list] saved in list.replace(saved) }
		detail.onDeleted = { [list] _ in Task { await list.refresh() } }
		_store = State(initialValue: detail)
		self.onGone = onGone
	}

	var body: some View {
		if store.isDeleted {
			EmptyState(symbol: "tray", title: "Trigger deleted")
				.onAppear(perform: onGone)
		} else {
			TriggerDetailView(store: store)
		}
	}
}
