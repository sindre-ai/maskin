import MaskinCore
import SwiftUI

/// The signed-in app: a tab bar on iPhone that becomes a sidebar on iPad and Mac, from one
/// declaration (`.sidebarAdaptable`).
///
/// CONTRACT FOR SCREENS. Each tab hosts a screen taking `AppEnvironment`:
/// `ForYouScreen`, `ChatsScreen`, `ObjectsScreen`. A screen OWNS its `NavigationStack` (or split
/// view) and applies `.shellToolbar(environment:)` to its root content so the profile menu
/// (workspace switcher, sign out) and the notifications bell appear on every tab.
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
					ForEach(ShellTab.allCases) { tab in
						ShellTabContent(tab: tab, environment: environment, runtime: runtime)
							.tabItem { Label(tab.title, systemImage: tab.systemImage) }
							.tag(tab)
					}
				}
			}
		}
		.environment(runtime)
		.environment(runtime.router)
		.sheet(isPresented: $runtime.showNotifications) {
			NotificationsScreen(environment: environment, store: runtime.notifications)
				.environment(runtime.router)
		}
		.sheet(item: $runtime.presentedObject) { object in
			ObjectSheet(environment: environment, runtime: runtime, objectId: object.id)
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

	var body: some View {
		TabView(selection: $runtime.selectedTab) {
			ForEach(ShellTab.allCases) { tab in
				Tab(tab.title, systemImage: tab.systemImage, value: tab) {
					ShellTabContent(tab: tab, environment: environment, runtime: runtime)
				}
			}
		}
		.tabViewStyle(.sidebarAdaptable)
		.minimizeTabBarOnScroll()
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
