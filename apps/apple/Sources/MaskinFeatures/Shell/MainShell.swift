import MaskinCore
import SwiftUI

/// The signed-in app: a tab bar on iPhone that becomes a sidebar on iPad and Mac, from one
/// declaration (`.sidebarAdaptable`).
///
/// CONTRACT FOR SCREENS. Each tab hosts a screen taking `AppEnvironment`:
/// `ForYouScreen`, `ChatsScreen`, `ObjectsScreen`, `LoopsScreen`, `AgentsScreen`, `SearchScreen`. A screen OWNS its `NavigationStack` (or split
/// view) and applies `.shellToolbar(environment:)` to its root content so the account menu
/// (notifications, workspace switcher, sign out) appears on every tab.
public struct MainShell: View {
	private let environment: AppEnvironment
	@Bindable private var runtime: AppRuntime

	public init(environment: AppEnvironment, runtime: AppRuntime) {
		self.environment = environment
		self.runtime = runtime
	}

	public var body: some View {
		Group {
			if #available(iOS 18, macOS 15, *) {
				AdaptiveTabs(environment: environment, runtime: runtime)
			} else {
				TabView(selection: $runtime.selectedTab) {
					ForEach(ShellTab.visible) { tab in
						ShellTabContent(tab: tab, environment: environment, runtime: runtime)
							.tabItem { Label(tab.title, systemImage: tab.systemImage) }
							.tag(tab)
					}
				}
			}
		}
		.environment(runtime)
		.environment(runtime.router)
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
	@Environment(\.horizontalSizeClass) private var sizeClass
	/// iPhone's tab bar holds five; Agents then lives in More rather than behind a system "More".
	private var isCompact: Bool { sizeClass == .compact }

	var body: some View {
		TabView(selection: $runtime.selectedTab) {
			ForEach(ShellTab.allCases.filter { $0 != .search && ($0 != .agents || !isCompact) }) { tab in
				Tab(tab.title, systemImage: tab.systemImage, value: tab) {
					ShellTabContent(tab: tab, environment: environment, runtime: runtime)
				}
			}
			// The system search role: a detached search button on iOS 26 (and a sidebar entry on the
			// Mac). Below iOS 26 search is a toolbar button instead — see `ShellTab.searchIsTab`.
			if ShellTab.searchIsTab {
				Tab(value: ShellTab.search, role: .search) {
					ShellTabContent(tab: .search, environment: environment, runtime: runtime)
				}
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
		switch presentation {
		case .object(let id):
			ObjectSheet(environment: environment, runtime: runtime, objectId: id)
		case .agent(let id):
			DetailSheet { AgentDetailScreen(environment: environment, agentId: id) }
		case .file(let id):
			DetailSheet { FileScreen(environment: environment, fileId: id) }
		case .search:
			DetailSheet { SearchScreen(environment: environment) { runtime.openSearchResult($0) } }
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
		case .objects: ObjectsScreen(environment: environment)
		case .loops: LoopsScreen(environment: environment)
		case .agents: AgentsScreen(environment: environment)
		case .more: MoreScreen(environment: environment, runtime: runtime)
		case .search:
			SearchScreen(environment: environment) { runtime.openSearchResult($0) }
		}
	}
}

extension View {
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
