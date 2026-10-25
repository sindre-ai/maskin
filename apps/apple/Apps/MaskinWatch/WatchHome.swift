import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The watch: three vertical pages on the Digital Crown. Home (ask the Chief of Staff, and what
/// waits on you), Briefing, Flows. Decisions and the conversation are pushed from Home.
struct WatchHome: View {
	let environment: AppEnvironment
	let store: ForYouStore?
	let watch: MaskinWatchStore
	@State private var loops: LoopsStore?
	@State private var conversation: WatchConversationStore
	@State private var page: Page = WatchHome.startingPage
	@State private var path: [WatchRoute] = []
	@State private var openFlow: String?
	@AppStorage(WatchFirstRun.doneKey) private var firstRunDone = false

	enum Page: Int { case home, briefing, flows }

	init(environment: AppEnvironment, store: ForYouStore?, watch: MaskinWatchStore) {
		self.environment = environment
		self.store = store
		self.watch = watch
		_conversation = State(initialValue: .live(environment: environment))
	}

	/// Design review only: `MASKIN_DEMO_PAGE=briefing` opens that page, because a simulator has no
	/// Digital Crown to scroll with. Always the first page in Release.
	private static var startingPage: Page {
		#if DEBUG
			switch ProcessInfo.processInfo.environment["MASKIN_DEMO_PAGE"] {
			case "briefing": return .briefing
			case "flows": return .flows
			default: break
			}
		#endif
		return .home
	}

	var body: some View {
		Group {
			if firstRunDone { pages } else { WatchFirstRun(done: $firstRunDone, ask: ask) }
		}
		// Whatever the live stores know becomes the snapshot the wrist falls back on offline, and
		// the complications reload with it.
		.onChange(of: liveSnapshot(now: .distantPast)) { _, next in
			guard store?.phase == .loaded, !next.cards.isEmpty || !next.flows.isEmpty || next.briefing != nil else { return }
			watch.publish(liveSnapshot(now: Date()))
		}
		.onChange(of: environment.auth.session == nil) { _, signedOut in
			if signedOut {
				watch.clear()
				conversation.stop()
				path = []
			}
		}
		// Actions are ink; the system accent would otherwise paint titles and links indigo.
		.tint(MaskinColor.ink)
		.task(id: environment.auth.credentials) {
			conversation.stop()
			await startLoops()
		}
		.onDisappear {
			loops?.stop()
			conversation.stop()
		}
	}

	private var pages: some View {
		TabView(selection: $page) {
			NavigationStack(path: $path) {
				WatchAskHome(store: store, watch: watch, ask: ask)
					.containerBackground(for: .navigation) { WatchBackdrop() }
					.toolbar(.hidden, for: .navigationBar)
					.navigationDestination(for: WatchRoute.self) { route in
						switch route {
						case .decisions:
							WatchNeedsYou(store: store, watch: watch, workspaceId: environment.workspaceId)
						case .conversation:
							WatchConversationScreen(conversation: conversation)
						}
					}
			}
			.tag(Page.home)
			WatchBriefing(store: store, watch: watch, firstName: firstName).tag(Page.briefing)
			WatchFlows(
				flows: flows, loaded: loops?.phase == .loaded || !watch.flows.isEmpty, store: store,
				openFlow: $openFlow
			).tag(Page.flows)
		}
		.tabViewStyle(.verticalPage)
		// A complication tap lands where it points, whichever page was showing last.
		.onOpenURL(perform: open)
	}

	/// The wearer asked something: hand it to the Chief of Staff and show the conversation.
	private func ask(_ text: String) {
		conversation.ask(text)
		firstRunDone = true
		page = .home
		if path.last != .conversation { path.append(.conversation) }
	}

	/// `maskin-watch://ask`, `needs-you`, `brief` and `flow/<id>`.
	private func open(_ url: URL) {
		guard url.scheme == "maskin-watch" else { return }
		switch url.host {
		case "ask":
			page = .home
			path = []
		case "needs-you":
			page = .home
			path = [.decisions]
		case "brief":
			page = .briefing
		case "flow":
			page = .flows
			openFlow = url.pathComponents.dropFirst().first
		default:
			break
		}
	}

	/// Live flows when they have loaded, else the last snapshot's.
	private var flows: [WatchSnapshot.Flow] {
		guard let loops, loops.phase == .loaded else { return watch.flows }
		return loops.loops.filter { $0.status != .draft }.map(WatchSnapshotBuilder.flow)
	}

	private func liveSnapshot(now: Date) -> WatchSnapshot {
		var briefMarkdown: String?
		if case .loaded(let brief) = store?.brief { briefMarkdown = brief.markdown }
		return WatchSnapshotBuilder.make(
			entries: store?.entries ?? [], sender: { store?.senderName(of: $0) },
			briefMarkdown: briefMarkdown, loops: loops?.phase == .loaded ? loops?.loops ?? [] : [],
			firstName: firstName, now: now)
	}

	private var firstName: String? {
		environment.auth.session?.name.split(separator: " ").first.map(String.init)
	}

	private func startLoops() async {
		loops?.stop()
		guard environment.auth.session != nil, let workspaceID = environment.workspaceId else {
			loops = nil
			return
		}
		let next = LoopsStore(
			api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events, cache: environment.snapshotCache)
		loops = next
		await next.start()
	}
}
