import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The tvOS app: the top tab bar the system draws, For you and Flows. Team and Objects arrive with
/// their own screens; an empty tab is never shipped.
struct TVRoot: View {
	let environment: AppEnvironment
	let store: ForYouStore?
	@State private var loops: LoopsStore?

	var body: some View {
		TabView {
			TVForYou(environment: environment, store: store)
				.tabItem { Text("For you") }
			TVFlows(environment: environment, loops: loops)
				.tabItem { Text("Flows") }
		}
		.task(id: environment.auth.credentials) { await startLoops() }
		.onDisappear { loops?.stop() }
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
