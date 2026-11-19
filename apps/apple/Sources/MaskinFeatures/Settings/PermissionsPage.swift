import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if canImport(AVFoundation)
import AVFoundation
#endif
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Permissions, pushed from Settings: the phone's own choices for Maskin in one place. iOS owns
/// each answer, so this shows what it will tell an app and leads to Settings > Maskin to change it.
struct PermissionsPage: View {
	@State private var statuses: [PermissionKind: PermissionStatus] = [:]
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		WorkspacePage(title: "Permissions") {
			PageCard(rows: rows)
			PageFootnote(text: PermissionsRules.pasteFootnote)
			if PermissionsRules.showsDeniedFootnote(statuses) {
				PageFootnote(text: PermissionsRules.deniedFootnote)
			}
			if opensSettings {
				Button("Open iOS Settings") { openSettings() }
					.buttonStyle(.primaryAction)
			}
		}
		.task(id: scenePhase) { await refresh() }
	}

	private var rows: [PageRowModel] {
		PermissionKind.allCases.map { kind in
			var row = PageRowModel(id: kind.id, title: kind.title, subtitle: kind.note)
			row.accessory = accessory(for: kind)
			if opensSettings {
				row.showsChevron = true
				row.action = { openSettings() }
			}
			return row
		}
	}

	/// iOS only: the other platforms have no Settings > Maskin page to go to.
	private var opensSettings: Bool {
		#if canImport(UIKit) && !os(watchOS) && !os(tvOS)
		return true
		#else
		return false
		#endif
	}

	private func accessory(for kind: PermissionKind) -> PageRowModel.Accessory {
		guard kind.isReadable, let status = statuses[kind] else { return .none }
		return .state(status.pageState)
	}

	private func refresh() async {
		var read: [PermissionKind: PermissionStatus] = [:]
		#if canImport(AVFoundation) && !os(watchOS) && !os(tvOS)
		switch AVAudioApplication.shared.recordPermission {
		case .granted: read[.microphone] = .allowed
		case .denied: read[.microphone] = .denied
		case .undetermined: read[.microphone] = .notAsked
		@unknown default: break
		}
		switch AVCaptureDevice.authorizationStatus(for: .video) {
		case .authorized: read[.camera] = .allowed
		case .denied, .restricted: read[.camera] = .denied
		case .notDetermined: read[.camera] = .notAsked
		@unknown default: break
		}
		#endif
		#if canImport(UserNotifications)
		let settings = await UNUserNotificationCenter.current().notificationSettings()
		switch settings.authorizationStatus {
		case .authorized, .provisional, .ephemeral: read[.notifications] = .allowed
		case .denied: read[.notifications] = .denied
		case .notDetermined: read[.notifications] = .notAsked
		@unknown default: break
		}
		#endif
		statuses = read
	}

	private func openSettings() {
		#if canImport(UIKit) && !os(watchOS) && !os(tvOS)
		if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
		#endif
	}
}

extension AppRuntime {
	/// Opens Settings on the Permissions page. What the microphone alert leads to, so a blocked
	/// permission is fixed in one place instead of each alert opening iOS Settings on its own.
	func openPermissions() {
		settingsRoute = .permissions
		presentation = .settings
	}
}
