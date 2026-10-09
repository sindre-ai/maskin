import MaskinCore
import SwiftUI

/// The signed-in app: a tab bar on iPhone that becomes a sidebar on iPad and Mac, from one
/// declaration (`.sidebarAdaptable`).
///
/// Four tabs (For you, Team, Flows, Objects) and the trailing system search tab. No More tab: the
/// avatar on every root screen opens the profile sheet (`ProfileSheet`).
///
/// CONTRACT FOR SCREENS. Each tab hosts a screen taking `AppEnvironment`:
/// `ForYouScreen`, `ChatsScreen`, `LoopsScreen`, `ObjectsScreen`, `SearchScreen`. A screen OWNS its
/// `NavigationStack` (or split view) and applies `.shellToolbar(environment:)` to its root content
/// so its bar items and the profile avatar appear.
public struct MainShell: View {
	private let environment: AppEnvironment
	@Bindable private var runtime: AppRuntime
	@State private var badges = ShellBadges()
	@State private var liveMeeting: LiveMeetingRequest?

	public init(environment: AppEnvironment, runtime: AppRuntime) {
		self.environment = environment
		self.runtime = runtime
		TabBarBadgeStyle.applyOnce()
	}

	public var body: some View {
		Group {
			if #available(iOS 18, macOS 15, *) {
				AdaptiveTabs(environment: environment, runtime: runtime, badges: badges)
			} else {
				TabView(selection: $runtime.selectedTab) {
					ForEach(ShellTab.allCases) { tab in
						ShellTabContent(tab: tab, environment: environment, runtime: runtime)
							.tabItem { Label(tab.title, systemImage: tab.systemImage) }
							.badge(tab.badge(runtime: runtime, badges: badges).label.map { Text($0) })
							.tag(tab)
					}
				}
			}
		}
		.environment(runtime)
		.environment(runtime.router)
		.environment(
			\.liveMeeting, LiveMeetingPresenter { request in liveMeeting = request }
		)
		.task(id: environment.workspaceId) { await badges.start(environment: environment) }
		.liveMeetingCover(item: $liveMeeting) { request in
			LiveMeetingScreen(request: request, environment: environment) { liveMeeting = nil }
		}
		.focusedSceneValue(\.appRuntime, runtime)
		.syncOfflineBanner(isOnline: runtime.isOnline)
		.sheet(item: $runtime.presentation) { presentation in
			PresentationContent(
				presentation: presentation, environment: environment, runtime: runtime)
		}
		.alert(
			"Can't open link", isPresented: rejectionBinding,
			actions: { Button("OK", role: .cancel) {} },
			message: { Text(runtime.rejectionMessage ?? "") })
	}

	private var rejectionBinding: Binding<Bool> {
		Binding(
			get: { runtime.rejectionMessage != nil },
			set: { if !$0 { runtime.router.clearRejection() } })
	}
}

@available(iOS 18, macOS 15, *)
private struct AdaptiveTabs: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	let badges: ShellBadges

	var body: some View {
		TabView(selection: $runtime.selectedTab) {
			ForEach(ShellTab.primary) { tab in
				Tab(tab.title, systemImage: tab.systemImage, value: tab) {
					ShellTabContent(tab: tab, environment: environment, runtime: runtime)
				}
				.badge(tab.badge(runtime: runtime, badges: badges).label.map { Text($0) })
			}
			// The system search role: a detached search button on iOS 26 (a plain trailing tab
			// before that, a sidebar entry on iPad and the Mac). The only search entry point.
			Tab(value: ShellTab.search, role: .search) {
				ShellTabContent(tab: .search, environment: environment, runtime: runtime)
			}
		}
		.tabViewStyle(.sidebarAdaptable)
		.minimizeTabBarOnScroll()
	}
}

/// The content of the shell's single sheet.
private struct PresentationContent: View {
	let presentation: AppRuntime.Presentation
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime

	var body: some View {
		content
			// Inside a sheet the avatar would open a profile sheet over the sheet.
			.environment(\.shellShowsAvatar, false)
	}

	@ViewBuilder private var content: some View {
		switch presentation {
		case .object(let id):
			ObjectSheet(environment: environment, runtime: runtime, objectId: id)
		case .agent(let id):
			DetailSheet { AgentDetailScreen(environment: environment, agentId: id) }
		case .file(let id):
			DetailSheet { FileScreen(environment: environment, fileId: id) }
		case .profile:
			ProfileSheet(environment: environment, runtime: runtime)
		case .files:
			FilesListScreen(environment: environment, onDone: { runtime.showFiles = false })
		case .agents:
			AgentsScreen(environment: environment)
		case .settings:
			SettingsScreen(environment: environment)
				.environment(runtime)
		}
	}
}

private struct ShellTabContent: View {
	let tab: ShellTab
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime

	var body: some View {
		switch tab {
		case .forYou:
			ForYouScreen(environment: environment) { runtime.openObject($0) }
		case .chats:
			ChatsScreen(
				environment: environment, requestedConversationId: $runtime.requestedConversationId)
		case .loops: LoopsScreen(environment: environment)
		case .objects: ObjectsScreen(environment: environment)
		case .search:
			SearchScreen(environment: environment) { runtime.openSearchResult($0) }
		}
	}
}

extension ShellTab {
	/// The badge on the tab: open decisions on For you (a dot when only updates are unread), unread
	/// conversations on Team. Nothing when there is nothing.
	@MainActor
	fileprivate func badge(runtime: AppRuntime, badges: ShellBadges) -> TabBadge {
		switch self {
		case .forYou:
			let store = runtime.forYou.store
			return .make(
				count: store.needsCount, hasUnreadWithoutCount: store.unreadCount > store.needsCount)
		case .chats: return .make(count: badges.unreadChats)
		default: return .none
		}
	}
}

extension View {
	/// The live meeting covers the whole screen on iPhone and iPad; a sheet on the Mac.
	fileprivate func liveMeetingCover<Item: Identifiable, Content: View>(
		item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content
	) -> some View {
		#if os(iOS)
			return fullScreenCover(item: item, content: content)
		#else
			return sheet(item: item, content: content)
		#endif
	}

	/// iOS 26: the tab bar collapses while scrolling down. No-op elsewhere.
	fileprivate func minimizeTabBarOnScroll() -> some View {
		#if os(iOS)
			if #available(iOS 26, *) {
				return AnyView(tabBarMinimizeBehavior(.onScrollDown))
			}
		#endif
		return AnyView(self)
	}
}

#Preview("Shell") {
	let environment = AppEnvironment.preview()
	MainShell(environment: environment, runtime: AppRuntime(environment: environment))
}
