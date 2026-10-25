import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The watch: three vertical pages on the Digital Crown. Needs you, Briefing, Flows. Nothing here
/// needs typing; threads, drafts and everything longer than a glance hand off to the iPhone.
struct WatchHome: View {
	let environment: AppEnvironment
	let store: ForYouStore?
	let watch: MaskinWatchStore
	@State private var loops: LoopsStore?
	@State private var page: Page = WatchHome.startingPage

	enum Page: Int { case needsYou, briefing, flows }

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
		return .needsYou
	}

	var body: some View {
		TabView(selection: $page) {
			WatchNeedsYou(store: store, watch: watch, workspaceId: environment.workspaceId).tag(Page.needsYou)
			WatchBriefing(store: store, watch: watch, firstName: firstName).tag(Page.briefing)
			WatchFlows(flows: flows, loaded: loops?.phase == .loaded || !watch.flows.isEmpty, store: store).tag(Page.flows)
		}
		// Whatever the live stores know becomes the snapshot the wrist falls back on offline, and
		// the complications reload with it.
		.onChange(of: liveSnapshot(now: .distantPast)) { _, next in
			guard store?.phase == .loaded, !next.cards.isEmpty || !next.flows.isEmpty || next.briefing != nil else { return }
			watch.publish(liveSnapshot(now: Date()))
		}
		.onChange(of: environment.auth.session == nil) { _, signedOut in
			if signedOut { watch.clear() }
		}
		.tabViewStyle(.verticalPage)
		// A complication tap lands on Needs you, whichever page was showing last.
		.onOpenURL { url in
			if url.scheme == "maskin-watch", url.host == "needs-you" { page = .needsYou }
		}
		// Actions are ink; the system accent would otherwise paint titles and links indigo.
		.tint(MaskinColor.ink)
		.task(id: environment.auth.credentials) { await startLoops() }
		.onDisappear { loops?.stop() }
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
