import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The tvOS app: the top tab bar the system draws, For you, Team, Flows, Objects and Profile.
struct TVRoot: View {
	let environment: AppEnvironment
	let store: ForYouStore?
	@State private var loops: LoopsStore?

	var body: some View {
		TabView {
			TVForYou(environment: environment, store: store)
				.tabItem { Text("For you") }
			TVTeam(environment: environment)
				.tabItem { Text("Team") }
			TVFlows(environment: environment, loops: loops)
				.tabItem { Text("Flows") }
			TVObjects(environment: environment)
				.tabItem { Text("Objects") }
			TVProfile(environment: environment)
				.tabItem { Text("Profile") }
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
