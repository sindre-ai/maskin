import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Notifications, pushed from Settings. Whether this device can notify is the system's
/// call, so this shows its answer and leads to the system Settings page to change it.
struct NotificationsPage: View {
	/// The running flows the person can follow on the Lock Screen. Empty hides the group.
	var flows: [LoopSummary] = []
	/// Nil where Live Activities don't exist (not iOS, or not started): the group is hidden.
	var cycles: CycleActivityController? = CycleActivityController.shared
	/// Names for the per-workspace mute list.
	var workspaces: [WorkspaceSummary] = []
	/// Present in the app; absent in previews and snapshots, where the preferences are left out.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var status: Status = .unknown
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase

	enum Status { case unknown, on, off, notAsked }

	var body: some View {
		WorkspacePage(title: "Notifications") {
			PageCard(rows: [
				PageRowModel(
					id: "decisions", title: "Decisions and replies",
					subtitle: "So decisions reach you when they matter",
					accessory: .state(stateText))
			])
			if let store = runtime?.notificationPreferences {
				NotificationPreferencesSection(store: store, workspaces: workspaces)
			}
			if let cycles, !followable.isEmpty {
				PageGroupLabel(text: "Flows")
				PageCard(
					rows: followable.map { flow in
						PageRowModel(
							id: flow.id, title: flow.displayName,
							subtitle: "Follow each cycle on the Lock Screen",
							accessory: .toggle(isOn: cycles.isOn(flow.id), set: { cycles.setOn($0, flowId: flow.id) }))
					})
				PageFootnote(text: "A card shows the cycle running now and turns to Needs you when it is waiting on you. It updates while Maskin is open.")
			}
			if status == .off {
				PageFootnote(text: "Notifications are off for Maskin on this device.")
			}
			if status == .off || status == .notAsked {
				Button(status == .off ? "Open Settings" : "Turn on notifications") { act() }
					.buttonStyle(.primaryAction)
			}
		}
		.task(id: scenePhase) { await refresh() }
		.task { await runtime?.notificationPreferences?.load() }
	}

	private var followable: [LoopSummary] { flows.filter { $0.status.isLive } }

	private var stateText: PageState {
		switch status {
		case .on: PageState("On", .active)
		case .off: PageState("Off", .muted)
		case .notAsked: PageState("Not asked", .muted)
		case .unknown: PageState("", .plain)
		}
	}

	private func refresh() async {
		#if canImport(UserNotifications)
		let settings = await UNUserNotificationCenter.current().notificationSettings()
		switch settings.authorizationStatus {
		case .authorized, .provisional, .ephemeral: status = .on
		case .denied: status = .off
		case .notDetermined: status = .notAsked
		@unknown default: status = .unknown
		}
		#endif
	}

	private func act() {
		#if canImport(UserNotifications)
		if status == .notAsked {
			Task {
				// The registrar asks, then registers for remote notifications once granted.
				await runtime?.requestPushPermission()
				await refresh()
			}
			return
		}
		#endif
		#if canImport(UIKit) && !os(watchOS)
		if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
		#endif
	}
}
