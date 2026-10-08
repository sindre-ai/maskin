import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The tvOS app: the top tab bar the system draws, For you, Team, Flows, Objects and Profile.
struct TVRoot: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	@State private var loops: LoopsStore?
	@State private var stories: StoriesStore?

	var body: some View {
		TabView {
			TVForYou(environment: environment, forYou: forYou, stories: stories)
				.tabItem { Text("For you") }
			TVTeam(environment: environment)
				.tabItem { Text("Team") }
			TVFlows(environment: environment, loops: loops)
				.tabItem { Text("Flows") }
			TVObjects(environment: environment)
				.tabItem { Text("Objects") }
			TVSearch(environment: environment)
				.tabItem { Image(systemName: "magnifyingglass") }
			TVProfile(environment: environment)
				.tabItem { Text("Profile") }
		}
		.task(id: environment.auth.credentials) {
			async let flows: Void = startLoops()
			async let briefings: Void = startStories()
			_ = await (flows, briefings)
		}
		.onDisappear { loops?.stop() }
	}

	/// The briefing and every flow's pages, loaded once per workspace.
	private func startStories() async {
		guard environment.auth.session != nil, let workspace = environment.workspaceId else {
			stories = nil
			return
		}
		let credentials = environment.auth.credentialsProvider
		let files = APIFilesRemote(client: environment.client, credentials: credentials)
		let next = StoriesStore(
			loops: APILoopsSource(
				client: environment.client, workspaceID: workspace,
				objects: APIObjectsRemote(client: environment.client, credentials: credentials), files: files),
			files: files, briefing: APISpokenBriefing(client: environment.client, workspaceID: workspace),
			readerName: { [weak environment] in environment?.auth.session?.name })
		stories = next
		await next.load()
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
