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

	var body: some View {
		TabView {
			WatchNeedsYou(store: store)
			WatchBriefing(store: store, firstName: firstName)
			WatchFlows(loops: loops)
		}
		.tabViewStyle(.verticalPage)
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
