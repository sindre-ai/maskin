import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The watch: three vertical pages on the Digital Crown. Needs you, Briefing, Flows. Nothing here
/// needs typing; threads, drafts and everything longer than a glance hand off to the iPhone.
struct WatchHome: View {
	let environment: AppEnvironment
	let store: ForYouStore?
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
			WatchNeedsYou(store: store, workspaceId: environment.workspaceId).tag(Page.needsYou)
			WatchBriefing(store: store, firstName: firstName).tag(Page.briefing)
			WatchFlows(loops: loops).tag(Page.flows)
		}
		.tabViewStyle(.verticalPage)
		// Actions are ink; the system accent would otherwise paint titles and links indigo.
		.tint(MaskinColor.ink)
		.task(id: environment.auth.credentials) { await startLoops() }
		.onDisappear { loops?.stop() }
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
