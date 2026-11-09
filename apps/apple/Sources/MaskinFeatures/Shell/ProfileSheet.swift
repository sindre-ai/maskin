import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The account menu the avatar opens on every root tab (large detent): who is signed in, then ONE
/// scrolling list of section headers over chevron rows (Account, Workspace, Agents and access,
/// Admin), then Appearance and Sign out.
///
/// The sheet hosts ONE `NavigationStack`. Every row pushes a page onto it, in its embedded mode
/// (no stack and no Done button of its own). An agent tapped in Members pushes too. Only the
/// workspace switcher is a sheet, because it is a picker.
struct ProfileSheet: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	@State private var path: [Route] = []
	@State private var showWorkspaces = false
	@State private var confirmSignOut = false
	/// The agents for the Members page and the working count; the figures beside the rows.
	@State private var agents: AgentsStore?
	@State private var counts: SettingsCountsStore?
	@AppStorage(AppearancePreference.storageKey) private var appearance: AppearancePreference = .system
	@Environment(AppLockController.self) private var appLock: AppLockController?
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, runtime: AppRuntime) {
		self.environment = environment
		self.runtime = runtime
		if let workspaceID = environment.workspaceId {
			_agents = State(
				initialValue: AgentsStore(
					api: APIAgentsSource(client: environment.client, workspaceID: workspaceID),
					events: nil, cache: environment.snapshotCache))
		}
		_counts = State(initialValue: SettingsServices(environment: environment).countsStore())
	}

	private enum Route: Hashable {
		case item(ProfileMenuItem)
		case agent(String)
	}

	private var hasWorkspace: Bool { environment.workspaceId != nil }

	/// The signed-in person's role here; unknown means least privilege.
	private var role: MemberRole {
		MemberRole(serverValue: environment.workspaces.selected?.role ?? "member")
	}

	var body: some View {
		NavigationStack(path: $path) {
			ScrollView {
				VStack(alignment: .leading, spacing: 0) {
					header
					// Global search: chats, flows, agents, items and automations in one place.
					sectionHeader(nil, spacing: MaskinSpace.s4)
					MenuRow(title: "Search", value: "Everything in the workspace") {
						runtime.presentation = .search
					}
					ForEach(ProfileMenuGroup.allCases) { group in
						let items = ProfileMenu.items(in: group, hasWorkspace: hasWorkspace)
						if !items.isEmpty {
							sectionHeader(group.title)
							ForEach(items) { item in
								MenuRow(title: item.title, value: value(for: item)) { path.append(.item(item)) }
							}
						}
					}
					sectionHeader(nil)
					MenuRow(title: "Appearance", value: appearance.title, chevron: false) {
						appearance = appearance.next
					}
					Button(role: .destructive) {
						confirmSignOut = true
					} label: {
						Text("Sign out")
							.maskinText(.body)
							.foregroundStyle(MaskinColor.danger)
							.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					versionFooter
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.bottom, MaskinSpace.s12)
			}
			.ambientBackground()
			.foregroundStyle(MaskinColor.ink)
			#if os(iOS)
				.toolbar(.hidden, for: .navigationBar)
			#endif
			.navigationDestination(for: Route.self) { route in
				destination(route)
					.environment(\.isPushedInHostStack, true)
					.environment(\.shellShowsAvatar, false)
			}
			.navigationDestination(for: SettingsRoute.self) {
				SettingsRouteView(route: $0, environment: environment)
					.environment(\.isPushedInHostStack, true)
					.environment(\.shellShowsAvatar, false)
			}
			// Signing out discards writes still waiting to send, so ask first.
			.confirmationDialog("Sign out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Sign out", role: .destructive) { Task { await runtime.signOut() } }
			} message: {
				Text("Anything still waiting to send will be discarded.")
			}
			.sheet(isPresented: $showWorkspaces) {
				// Picking a workspace resets the app to For you and closes this sheet (`AppRuntime.sync`).
				WorkspaceSwitcher(environment: environment)
					.presentationDetents([.medium, .large])
					.environment(\.shellShowsAvatar, false)
			}
			.task {
				if let agents { await agents.refresh() }
				await counts?.load()
			}
		}
		.presentationDetents([.large])
		.environment(\.shellShowsAvatar, false)
	}

	// MARK: Header

	/// Who is signed in, with the workspace and role under the name; Switch changes workspace.
	@ViewBuilder private var header: some View {
		if let session = environment.auth.session {
			HStack(spacing: MaskinSpace.s8) {
				ActorAvatar(
					name: session.name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s12, seed: session.actorId)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(session.name).maskinText(.title).foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Text(subtitle(email: session.email)).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
						.lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s4)
				Button("Switch") { showWorkspaces = true }
					.buttonStyle(.maskinPressed)
					.maskinText(.subhead).fontWeight(.bold)
					.foregroundStyle(MaskinColor.accent)
					.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
			}
			.padding(.top, MaskinSpace.s12)
			.padding(.bottom, MaskinSpace.s4)
		}
	}

	/// "Workspace name · Owner", else the email when no workspace is selected.
	private func subtitle(email: String?) -> String {
		guard let name = environment.workspaces.selected?.name else { return email ?? "" }
		return "\(name) \u{00B7} \(role.label)"
	}

	private func sectionHeader(_ title: String?, spacing: CGFloat = MaskinSpace.s12) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			if let title {
				Text(title)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink4)
					.padding(.top, MaskinSpace.s12)
					.padding(.bottom, MaskinSpace.s4)
					.accessibilityAddTraits(.isHeader)
			} else {
				Spacer().frame(height: spacing)
			}
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
		}
	}

	// MARK: Pages

	/// The figure at the right of a row, only when it is known.
	private func value(for item: ProfileMenuItem) -> String? {
		switch item {
		case .account: environment.auth.session?.name
		case .billing: counts?.plan
		case .appLock: appLock.map { $0.isEnabled ? "On" : "Off" }
		case .agents: (agents?.workingCount ?? 0) > 0 ? "\(agents?.workingCount ?? 0) working" : nil
		case .members: SettingsCountsStore.detail(counts?.members)
		case .integrations: counts?.integrationsDetail
		case .triggers: SettingsCountsStore.detail(counts?.triggers)
		case .skills: SettingsCountsStore.detail(counts?.skills)
		case .objectTypes: SettingsCountsStore.detail(counts?.itemTypes)
		default: nil
		}
	}

	@ViewBuilder
	private func destination(_ route: Route) -> some View {
		switch route {
		case .item(let item): page(for: item)
		case .agent(let id): AgentDetailScreen(environment: environment, agentId: id)
		}
	}

	@ViewBuilder
	private func page(for item: ProfileMenuItem) -> some View {
		let services = SettingsServices(environment: environment)
		switch item {
		case .settings:
			SettingsScreen(environment: environment)
		case .agents:
			AgentsScreen(environment: environment)
		case .marketplace:
			if let workspaceID = environment.workspaceId {
				MarketplaceSheet(
					environment: environment, workspaceID: workspaceID,
					onOpenLoop: { _ in
						runtime.presentation = nil
						runtime.selectedTab = .loops
					})
			}
		case .members:
			MembersView(
				store: services.membersStore(), agents: agents, invitations: services.invitationsStore(),
				onOpenAgent: { path.append(.agent($0)) },
				onHire: { path.append(.item(.marketplace)) })
		default:
			if let route = item.settingsRoute { SettingsRouteView(route: route, environment: environment) }
		}
	}

	/// The build that is running, so a tester can say which one they are looking at.
	@ViewBuilder private var versionFooter: some View {
		if let version = Self.versionText {
			Text(version)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
				.frame(maxWidth: .infinity)
				.padding(.top, MaskinSpace.s8)
		}
	}

	private static var versionText: String? {
		let info = Bundle.main.infoDictionary
		guard let short = info?["CFBundleShortVersionString"] as? String else { return nil }
		guard let build = info?["CFBundleVersion"] as? String else { return "Maskin \(short)" }
		return "Maskin \(short) (\(build))"
	}
}

extension ProfileMenuItem {
	/// The Settings page a row opens; Settings, Agents, Members and Marketplace have their own pages here.
	fileprivate var settingsRoute: SettingsRoute? {
		switch self {
		case .account: .profile
		case .billing: .billing
		case .notifications: .notifications
		case .appLock: .appLock
		case .deviceSignIn: .deviceSignIn
		case .integrations: .integrations
		case .triggers: .triggers
		case .skills: .skills
		case .objectTypes: .objectTypes
		case .keys: .keys
		case .nativeSurfaces: .nativeSurfaces
		case .advanced: .advanced
		case .settings, .agents, .members, .marketplace: nil
		}
	}
}

/// One row: the title at the left, the figure and a chevron at the right, a hairline under it.
private struct MenuRow: View {
	let title: String
	var value: String?
	var chevron = true
	let action: () -> Void

	var body: some View {
		VStack(spacing: 0) {
			Button(action: action) {
				HStack(spacing: MaskinSpace.s4) {
					Text(title).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
					Spacer(minLength: MaskinSpace.s4)
					if let value {
						Text(value).maskinText(.body).foregroundStyle(MaskinColor.ink4).lineLimit(1)
					}
					if chevron {
						Image(systemName: "chevron.right")
							.maskinSymbol(MaskinSpace.s7, weight: .semibold)
							.foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
				}
				.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s6)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.maskinHover()
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
		}
		.accessibilityElement(children: .combine)
	}
}
