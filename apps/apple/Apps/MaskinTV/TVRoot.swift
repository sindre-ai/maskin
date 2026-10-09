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
	/// A full-screen page (Decision) takes the top bar away; Menu brings it back.
	@State private var chromeHidden = false
	@State private var tab: Tab = Tab.demoStart
	/// A decision a Top Shelf item (or any maskin:// link) asked to open.
	@State private var openDecision: String?

	enum Tab: Hashable {
		case forYou, team, flows, objects, search, profile

		/// Debug builds can open on any tab so a screen can be screenshotted without a remote.
		static var demoStart: Tab {
			#if DEBUG
			let names: [String: Tab] = [
				"team": .team, "flows": .flows, "objects": .objects, "search": .search, "profile": .profile,
			]
			return ProcessInfo.processInfo.environment["MASKIN_DEMO_TAB"].flatMap { names[$0] } ?? .forYou
			#else
			return .forYou
			#endif
		}
	}

	var body: some View {
		ZStack {
			TVBackdrop()
			VStack(spacing: 0) {
				if !chromeHidden { TVTopBar(
					items: [
						.init(tab: .forYou, title: "For you", count: forYou?.store.entries.filter { $0.section == .needs }.count ?? 0),
						.init(tab: .team, title: "Team"),
						.init(tab: .flows, title: "Flows"),
						.init(tab: .objects, title: "Objects"),
					], selection: $tab, search: .search, profile: .profile, initials: initials) }
				screen
			}
			.ignoresSafeArea()
		}
		.overlay(alignment: .topTrailing) {
			// Last data stays on screen while the connection is down; this says so.
			if environment.events.connection == .failed {
				Text("OFFLINE")
					.font(.system(size: 24, weight: .semibold, design: .monospaced))
					.foregroundStyle(MaskinColor.ink4)
					.padding(.top, 20).padding(.trailing, 96)
					.accessibilityLabel("Offline. Showing the last data.")
			}
		}
		.onOpenURL { url in
			// A Top Shelf item: open that decision, but only in the workspace the TV is showing.
			guard let link = DeepLink(url: url), case .object(let workspace, let id) = link,
				workspace == environment.workspaceId
			else { return }
			tab = .forYou
			openDecision = id
		}
		.task(id: environment.auth.credentials) {
			async let flows: Void = startLoops()
			async let briefings: Void = startStories()
			_ = await (flows, briefings)
		}
		.onDisappear { loops?.stop() }
	}

	@ViewBuilder private var screen: some View {
		switch tab {
		case .forYou:
			TVForYou(environment: environment, forYou: forYou, stories: stories, openDecision: $openDecision,
				chromeHidden: $chromeHidden)
		case .team: TVTeam(environment: environment)
		case .flows: TVFlows(environment: environment, loops: loops, chromeHidden: $chromeHidden)
		case .objects: TVObjects(environment: environment)
		case .search: TVSearch(environment: environment)
		case .profile: TVProfile(environment: environment)
		}
	}

	private var initials: String {
		let words = (environment.auth.session?.name ?? "").split(separator: " ")
		return String(words.prefix(2).compactMap(\.first)).uppercased()
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
