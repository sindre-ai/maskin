import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The profile sheet the account icon opens (full height). A centred "Profile" title with a Done
/// capsule, then filled cards on 12 pt gaps: who is signed in (opens Account), the workspace with
/// Switch, three stat tiles that are links, and Search. Below, the settings rows under small
/// uppercase labels, one grouped card per section (Account, Workspace, Agents and access, Admin),
/// then Appearance and Sign out.
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
	/// Flows and agents for the stat tiles, the workspace line and the Members page. Built once per
	/// sheet with no live subscription: they hydrate from the shared snapshot cache and refresh once.
	@State private var loops: LoopsStore?
	@State private var agents: AgentsStore?
	@State private var counts: SettingsCountsStore?
	@AppStorage(AppearancePreference.storageKey) private var appearance: AppearancePreference = .system
	@Environment(AppLockController.self) private var appLock: AppLockController?
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, runtime: AppRuntime) {
		self.environment = environment
		self.runtime = runtime
		if let workspaceID = environment.workspaceId {
			_loops = State(
				initialValue: LoopsStore(
					api: APILoopsSource(client: environment.client, workspaceID: workspaceID),
					events: nil, cache: environment.snapshotCache))
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
				VStack(spacing: MaskinSpace.s7) {
					titleBar
					profileCard
					workspaceCard
					statTiles
					searchCard
					ForEach(ProfileMenuGroup.allCases) { group in
						let items = ProfileMenu.items(in: group, hasWorkspace: hasWorkspace)
						if !items.isEmpty {
							groupLabel(group.title)
							grouped(
								items.map { item in
									AnyView(
										ProfileRow(
											title: item.title, symbol: item.symbol, value: value(for: item)
										) { path.append(.item(item)) })
								})
						}
					}
					groupLabel(nil)
					grouped([
						AnyView(
							ProfileRow(title: "Appearance", symbol: appearance.symbol, value: appearance.title, chevron: false) {
								appearance = appearance.next
							}),
						AnyView(signOutRow),
					])
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
				if let loops { await loops.refresh() }
				if let agents { await agents.refresh() }
				await counts?.load()
			}
		}
		.presentationDetents([.large])
		.presentationCornerRadius(36)
		.environment(\.shellShowsAvatar, false)
	}

	// MARK: Title bar

	/// "Profile", centred, with a Done capsule on the right.
	private var titleBar: some View {
		ZStack {
			Text("Profile")
				.font(MaskinTypeface.sans(MaskinFontSize.t19, weight: .bold, relativeTo: .headline))
				.accessibilityAddTraits(.isHeader)
			HStack {
				Spacer()
				Button("Done") { dismiss() }
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink)
					.padding(.horizontal, MaskinSpace.s10)
					.frame(height: MaskinSpace.touchMin)
					.maskinGlassCapsule(interactive: true)
			}
		}
		.padding(.top, MaskinSpace.s9)
	}

	// MARK: Cards

	/// Who is signed in; tap for Account.
	@ViewBuilder private var profileCard: some View {
		if let session = environment.auth.session {
			Button {
				path.append(.item(.account))
			} label: {
				HStack(spacing: MaskinSpace.s8) {
					ActorAvatar(
						name: session.name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s12, seed: session.actorId)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(session.name)
							.font(MaskinTypeface.sans(MaskinFontSize.t18, weight: .semibold, relativeTo: .headline))
							.foregroundStyle(MaskinColor.ink)
							.lineLimit(1)
						Text(profileSubtitle(email: session.email)).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							.lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s4)
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinSpace.s7, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
				}
				.padding(MaskinSpace.s9)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Account, \(session.name)")
			.filledCard(radius: MaskinRadius.tile)
		}
	}

	/// "Workspace name · Owner", else the email when no workspace is selected.
	private func profileSubtitle(email: String?) -> String {
		guard let name = environment.workspaces.selected?.name else { return email ?? "" }
		return "\(name) \u{00B7} \(role.label)"
	}

	/// "4 agents · 3 flows".
	private var workspaceSubtitle: String {
		let agentCount = agents?.agents.count ?? 0
		let flowCount = loops?.loops.count ?? 0
		return "\(agentCount) \(agentCount == 1 ? "agent" : "agents") \u{00B7} \(flowCount) \(flowCount == 1 ? "flow" : "flows")"
	}

	/// The workspace you are working in, with Switch.
	private var workspaceCard: some View {
		HStack(spacing: MaskinSpace.s8) {
			MaskinLogoTile(size: MaskinSpace.s14 + MaskinSpace.s7)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(environment.workspaces.selected?.name ?? "Choose workspace")
					.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(workspaceSubtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s4)
			Button("Switch") { showWorkspaces = true }
				.buttonStyle(.maskinPressed)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
				.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
		}
		.padding(MaskinSpace.s9)
		.frame(minHeight: MaskinSpace.touchMin)
		.filledCard(radius: MaskinRadius.tile)
	}

	/// Three links under the workspace: what is waiting, the flows, the agents at work.
	private var statTiles: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			ProfileStatTile(
				value: runtime.forYou.store.needsCount, label: "waiting on you", destination: "For you"
			) {
				runtime.presentation = nil
				runtime.selectedTab = .forYou
			}
			ProfileStatTile(value: loops?.loops.count ?? 0, label: "flows you own", destination: "Flows") {
				loops?.needsYouOnly = false
				runtime.presentation = nil
				runtime.selectedTab = .loops
			}
			ProfileStatTile(value: agents?.workingCount ?? 0, label: "agents working", destination: "Members") {
				path.append(.item(.members))
			}
		}
	}

	/// Global search: chats, flows, agents, items and automations in one place.
	private var searchCard: some View {
		Button {
			runtime.presentation = .search
		} label: {
			HStack(spacing: MaskinSpace.s8) {
				Image(systemName: "magnifyingglass")
					.maskinSymbol(MaskinFontSize.t17, weight: .semibold)
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
				Text("Search").font(MaskinTypeface.sans(MaskinFontSize.t17, relativeTo: .body)).foregroundStyle(MaskinColor.ink4)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s5, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Search")
		.accessibilityHint("Chats, flows, agents, items and automations")
		.filledCard(radius: MaskinRadius.tile)
	}

	// MARK: Settings rows

	/// A 12 pt uppercase label above a grouped card; none for the last card.
	@ViewBuilder
	private func groupLabel(_ text: String?) -> some View {
		if let text {
			Text(text)
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
				.tracking(0.14 * MaskinFontSize.t12)
				.textCase(.uppercase)
				.foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, MaskinSpace.s4)
				.padding(.top, MaskinSpace.s7)
				.accessibilityAddTraits(.isHeader)
		}
	}

	/// One grouped card: radius 16, hairline separators between rows.
	private func grouped(_ rows: [AnyView]) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
				if index > 0 {
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
						.padding(.leading, MaskinSpace.s9 + ProfileTile.size + MaskinSpace.s8)
				}
				row
			}
		}
		.filledCard(radius: MaskinRadius.panelXl)
	}

	private var signOutRow: some View {
		Button(role: .destructive) {
			confirmSignOut = true
		} label: {
			HStack(spacing: MaskinSpace.s8) {
				ProfileTile(symbol: "rectangle.portrait.and.arrow.right", tint: MaskinColor.danger)
				Text("Sign out")
					.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.danger)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}

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

	// MARK: Pages

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
				.padding(.top, MaskinSpace.s4)
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

	/// The row's SF Symbol, in its 40 pt tile.
	fileprivate var symbol: String {
		switch self {
		case .account: "person.crop.circle"
		case .billing: "creditcard"
		case .notifications: "bell"
		case .appLock: "lock"
		case .deviceSignIn: "appletv"
		case .agents: "sparkles"
		case .members: "person.2"
		case .integrations: "puzzlepiece.extension"
		case .triggers: "bolt"
		case .skills: "wand.and.stars"
		case .objectTypes: "square.stack.3d.up"
		case .keys: "key"
		case .marketplace: "square.grid.2x2"
		case .nativeSurfaces: "iphone.gen3"
		case .advanced: "gearshape.2"
		}
	}
}

/// A 40 pt icon tile, radius 11.
private struct ProfileTile: View {
	static let size: CGFloat = MaskinSpace.s14 + MaskinSpace.s4
	let symbol: String
	var tint: Color = MaskinColor.ink2

	var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(MaskinSpace.s10, weight: .semibold)
			.foregroundStyle(tint)
			.frame(width: Self.size, height: Self.size)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.inputLg, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// One stat tile: a 26 pt number, a 13 pt caption and a 14 pt accent link naming where it goes.
/// Pure values in, so it renders in snapshots.
struct ProfileStatTile: View {
	let value: Int
	let label: String
	let destination: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("\(value)")
					.font(MaskinTypeface.sans(MaskinFontSize.t26, weight: .bold, relativeTo: .title))
					.foregroundStyle(MaskinColor.ink)
					.monospacedDigit()
				Text(label)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink4)
					.fixedSize(horizontal: false, vertical: true)
				Text(destination)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.accent)
					.padding(.top, MaskinSpace.s2)
			}
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.filledCard(radius: MaskinRadius.tile)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(value) \(label). Opens \(destination)")
	}
}

/// One row: a 40 pt icon tile, a 17 pt semibold label, an optional value, and a chevron.
private struct ProfileRow: View {
	let title: String
	let symbol: String
	var value: String?
	var chevron = true
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s8) {
				ProfileTile(symbol: symbol)
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink).lineLimit(1)
				Spacer(minLength: MaskinSpace.s4)
				if let value {
					Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
				if chevron {
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinSpace.s7, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.maskinHover()
		.accessibilityElement(children: .combine)
	}
}

extension View {
	/// A filled card on the iOS canvas: surface colour, 1 pt line, continuous corners.
	fileprivate func filledCard(radius: CGFloat) -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: radius, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
			.clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
	}
}
