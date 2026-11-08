import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings, presented by the shell as a sheet or destination. Owns its `NavigationStack` and a
/// Done button.
///
/// Five sections: Account (Account, Billing), Preferences (Notifications, App lock, Sign in a
/// device), Workspace (Members, Integrations, Triggers, Files), Agents and access (Skills, Item
/// types, Keys and secrets) and one Advanced row. Advanced holds Native surfaces, the state
/// previews, About and the danger zone. A figure sits beside a row only when it is known.
public struct SettingsScreen: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(\.isPushedInHostStack) private var pushed
	private let environment: AppEnvironment
	@State private var services: SettingsServices
	private var analytics: Analytics { .shared }
	@State private var path: [SettingsRoute]
	@State private var counts: SettingsCountsStore?
	/// Present inside the signed-in app; nil in previews, which hides the App lock row.
	@Environment(AppLockController.self) private var appLock: AppLockController?

	/// `initialRoute` opens straight onto one page, with Settings behind it.
	public init(environment: AppEnvironment) { self.init(environment: environment, initialRoute: nil) }

	/// Settings opened onto Sign in a device with a code from `maskin://connect?code=`.
	public init(environment: AppEnvironment, deviceCode: String) {
		self.init(environment: environment, initialRoute: .deviceCode(deviceCode))
	}

	init(environment: AppEnvironment, initialRoute: SettingsRoute?) {
		self.environment = environment
		_path = State(initialValue: initialRoute.map { [$0] } ?? [])
		_services = State(initialValue: SettingsServices(environment: environment))
	}

	public var body: some View {
		if pushed { hub } else { NavigationStack(path: $path) { hub } }
	}

	private var hasWorkspace: Bool { services.workspaceId != nil }

	private var hub: some View {
		List {
			ForEach(SettingsPageRow.Section.allCases) { section in
				let rows = SettingsPageRow.rows(in: section, hasWorkspace: hasWorkspace)
				if !rows.isEmpty {
					Section {
						ForEach(rows, id: \.self) { row in
							if row == .appLock, !showsAppLock {
								EmptyView()
							} else {
								NavigationLink(value: row.route) {
									SettingsRow(symbol: row.symbol, title: row.title, detail: detail(for: row))
								}
							}
						}
						// Only in builds that can send. Off until the person agrees (the first-run question).
						if section == .preferences, analytics.isAvailable {
							Toggle(
								AnalyticsCopy.settingsTitle,
								isOn: Binding(
									get: { analytics.consent == .granted }, set: { analytics.setConsent($0) }))
						}
					} header: {
						if let title = section.title { Text(title) }
					} footer: {
						if section == .preferences, analytics.isAvailable { Text(AnalyticsCopy.settingsFooter) }
					}
				}
			}
		}
		.settingsListStyle()
		.task { await loadCounts() }
		.navigationTitle("Settings")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			if !pushed {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
		.navigationDestination(for: SettingsRoute.self) {
			SettingsRouteView(route: $0, environment: environment).environment(\.isPushedInHostStack, pushed)
		}
	}

	private var showsAppLock: Bool {
		guard let appLock else { return false }
		return appLock.availability != .unavailable || appLock.isEnabled
	}

	private func detail(for row: SettingsPageRow) -> String? {
		switch row {
		case .account: environment.auth.session?.name
		case .billing: counts?.plan
		case .appLock: appLock.map { $0.isEnabled ? "On" : "Off" }
		case .members: SettingsCountsStore.detail(counts?.members)
		case .integrations: counts?.integrationsDetail
		case .triggers: SettingsCountsStore.detail(counts?.triggers)
		case .files: SettingsCountsStore.detail(counts?.files)
		case .skills: SettingsCountsStore.detail(counts?.skills)
		case .objectTypes: SettingsCountsStore.detail(counts?.itemTypes)
		default: nil
		}
	}

	private func loadCounts() async {
		if counts == nil { counts = services.countsStore() }
		await counts?.load()
	}

	static func appLockFooter(_ availability: AppLockAvailability, delay: AppLockDelay = .default) -> String {
		let how: String
		switch availability {
		case .biometric(let name): how = "Unlock with \(name) or your device passcode."
		case .passcodeOnly, .unavailable: how = "Unlock with your device passcode."
		}
		return "\(how) Maskin locks when you open it, and \(delay == .immediately ? "as soon as you leave it" : "after \(delay.label) in the background")."
	}

	static var versionString: String {
		let info = Bundle.main.infoDictionary
		let version = info?["CFBundleShortVersionString"] as? String ?? "dev"
		let build = info?["CFBundleVersion"] as? String
		return build.map { "\(version) (\($0))" } ?? version
	}
}

extension SettingsPageRow {
	var route: SettingsRoute {
		switch self {
		case .account: .profile
		case .billing: .billing
		case .notifications: .notifications
		case .appLock: .appLock
		case .deviceSignIn: .deviceSignIn
		case .members: .members
		case .integrations: .integrations
		case .triggers: .triggers
		case .files: .files
		case .skills: .skills
		case .objectTypes: .objectTypes
		case .keys: .keys
		case .advanced: .advanced
		}
	}

	var symbol: String {
		switch self {
		case .account: "person.crop.circle"
		case .billing: "creditcard"
		case .notifications: "bell"
		case .appLock: "lock"
		case .deviceSignIn: "appletv"
		case .members: "person.2"
		case .integrations: "puzzlepiece.extension"
		case .triggers: "bolt"
		case .files: "doc.text"
		case .skills: "wand.and.stars"
		case .objectTypes: "square.stack.3d.up"
		case .keys: "key"
		case .advanced: "gearshape.2"
		}
	}
}
