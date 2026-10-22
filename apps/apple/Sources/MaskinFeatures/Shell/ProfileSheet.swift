import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The profile sheet the avatar opens on every root tab (large detent): who is signed in (tap for
/// Your profile), the workspace with Switch, three stat tiles that are links (For you · Flows ·
/// Members), the WORKSPACE and YOU groups, and Log out. Replaces the More tab. There is no Agents
/// row: agents live inside Members (handoff `7-Chat.md` §10).
///
/// The sheet hosts ONE `NavigationStack`. Every row pushes a page onto it (Your profile, Members,
/// Integrations, Triggers, Billing, Keys & MCP, and the existing Marketplace, Artefacts and Settings
/// screens in their embedded mode: no stack and no Done button of their own). An agent tapped in
/// Members pushes too. Only the workspace switcher is still a sheet, because it is a picker.
struct ProfileSheet: View {
	let environment: AppEnvironment
	@Bindable var runtime: AppRuntime
	@State private var path: [Route] = []
	@State private var showWorkspaces = false
	@State private var confirmSignOut = false
	/// Flows and agents for the stat tiles and the Members page. Built once per sheet with no live
	/// subscription: they hydrate from the shared snapshot cache and refresh once on appear.
	@State private var loops: LoopsStore?
	@State private var agents: AgentsStore?
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
	}

	private enum Route: Hashable {
		case yourProfile
		case item(ProfileMenuItem)
		case agent(String)
	}

	private var hasWorkspace: Bool { environment.workspaceId != nil }

	/// The signed-in person's role here; unknown means least privilege (hides Keys).
	private var role: MemberRole {
		MemberRole(serverValue: environment.workspaces.selected?.role ?? "member")
	}

	var body: some View {
		NavigationStack(path: $path) {
			ScrollView {
				VStack(spacing: MaskinSpace.gapSection) {
					profileCard
					workspaceCard
					statTiles
					ForEach(ProfileMenuGroup.allCases) { group in
						let items = ProfileMenu.items(in: group, hasWorkspace: hasWorkspace, role: role)
						if !items.isEmpty {
							groupLabel(group.title)
							card(items)
						}
					}
					signOutCard
					versionFooter
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
			}
			.ambientBackground()
			.foregroundStyle(MaskinColor.ink)
			.navigationTitle("Profile")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.navigationDestination(for: Route.self) { route in
				destination(route)
					.environment(\.isPushedInHostStack, true)
					.environment(\.shellShowsAvatar, false)
			}
			// Signing out discards writes still waiting to send, so ask first (Settings does too).
			.confirmationDialog("Log out of Maskin?", isPresented: $confirmSignOut, titleVisibility: .visible) {
				Button("Log out", role: .destructive) { Task { await runtime.signOut() } }
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
			}
		}
		.presentationDetents([.large])
		.environment(\.shellShowsAvatar, false)
	}

	// MARK: Pushed pages

	@ViewBuilder
	private func destination(_ route: Route) -> some View {
		switch route {
		case .yourProfile:
			YourProfilePage(environment: environment)
		case .item(let item):
			page(for: item)
		case .agent(let id):
			AgentDetailScreen(environment: environment, agentId: id)
		}
	}

	@ViewBuilder
	private func page(for item: ProfileMenuItem) -> some View {
		let services = SettingsServices(environment: environment)
		switch item {
		case .marketplace:
			if let workspaceID = environment.workspaceId {
				MarketplaceSheet(
					environment: environment, workspaceID: workspaceID,
					onOpenLoop: { _ in
						runtime.presentation = nil
						runtime.selectedTab = .loops
					})
			}
		case .artefacts:
			FilesListScreen(environment: environment)
		case .members:
			MembersView(
				store: services.membersStore(), agents: agents,
				onOpenAgent: { path.append(.agent($0)) },
				onHire: { path.append(.item(.marketplace)) })
		case .integrations:
			IntegrationsView(
				store: services.integrationsStore(), webSetupURL: services.webURL("integrations"))
		case .triggers:
			if let workspaceID = environment.workspaceId {
				TriggersPage(environment: environment, workspaceID: workspaceID)
			}
		case .billing:
			BillingView(
				store: services.billingStore(),
				manageURL: services.role == .owner ? services.webURL("billing") : nil)
		case .keys:
			KeysPage(
				store: services.apiKeyStore(), mcp: services.mcpStore(),
				workspaceId: services.workspaceId ?? "", apiKey: services.apiKey)
		case .settings:
			SettingsScreen(environment: environment)
		case .autonomy:
			if let workspaceID = environment.workspaceId {
				AutonomyView(
					store: AutonomyStore(
						workspaceID: workspaceID, actorID: environment.auth.session?.actorId ?? "",
						storage: UserDefaultsAutonomyStorage()))
			}
		}
	}

	// MARK: Cards

	/// Who is signed in; tap for Your profile.
	@ViewBuilder private var profileCard: some View {
		if let session = environment.auth.session {
			NavigationLink(value: Route.yourProfile) {
				HStack(spacing: MaskinSpace.s8) {
					ActorAvatar(name: session.name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s12)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(session.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						Text(profileSubtitle(email: session.email)).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
							.lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s4)
					Text("Your profile").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinSpace.s7, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
				}
				.padding(MaskinSpace.s9)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Your profile, \(session.name)")
			.profileCard()
		}
	}

	/// "Owner · Workspace name", else the email when no workspace is selected.
	private func profileSubtitle(email: String?) -> String {
		guard let name = environment.workspaces.selected?.name else { return email ?? "" }
		return "\(role.label) \u{00B7} \(name)"
	}

	/// "4 agents · 3 flows · switch workspace".
	private var workspaceSubtitle: String {
		let agentCount = agents?.agents.count ?? 0
		let flowCount = loops?.loops.count ?? 0
		return "\(agentCount) \(agentCount == 1 ? "agent" : "agents") \u{00B7} \(flowCount) \(flowCount == 1 ? "flow" : "flows") \u{00B7} switch workspace"
	}

	/// The workspace you are working in, with Switch.
	private var workspaceCard: some View {
		HStack(spacing: MaskinSpace.s8) {
			MaskinLogoTile(size: ProfileTile.size)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(environment.workspaces.selected?.name ?? "Choose workspace")
					.maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(workspaceSubtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: MaskinSpace.s4)
			Button("Switch") { showWorkspaces = true }
				.buttonStyle(.maskinPressed)
				.maskinText(.subhead).fontWeight(.bold)
				.foregroundStyle(MaskinColor.ink)
				.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s5)
		.frame(minHeight: MaskinSpace.touchMin)
		.profileCard()
	}

	// MARK: Stat tiles

	/// Three links under the workspace: what is waiting, the flows, the agents at work. Each shows
	/// where it goes in `sigInk`. Counts are the app's own: For you's open decisions, the flows in
	/// the workspace, the agents with a live session.
	private var statTiles: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
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

	private func card(_ items: [ProfileMenuItem]) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(items.enumerated()), id: \.element) { index, item in
				if index > 0 { separator() }
				ProfileRow(
					title: item.title, subtitle: item.subtitle, symbol: item.symbol,
					value: item == .members ? environment.workspaces.selected.map { "\($0.memberCount)" } : nil
				) { path.append(.item(item)) }
			}
		}
		.profileCard()
	}

	private func groupLabel(_ text: String) -> some View {
		Text(text)
			.maskinText(.microLabel)
			.textCase(.uppercase)
			.foregroundStyle(MaskinColor.ink4)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s4)
			.accessibilityAddTraits(.isHeader)
	}

	private var signOutCard: some View {
		Button(role: .destructive) {
			confirmSignOut = true
		} label: {
			Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
				.maskinText(.body)
				.foregroundStyle(MaskinColor.danger)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.profileCard()
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

	private func separator() -> some View {
		Rectangle()
			.fill(MaskinSurface.separator)
			.frame(height: 1)
			.padding(.leading, MaskinSpace.s9 + ProfileTile.size + MaskinSpace.s8)
	}
}

extension ProfileMenuItem {
	fileprivate var symbol: String {
		switch self {
		case .marketplace: "square.grid.2x2"
		case .artefacts: "doc.text"
		case .settings: "gearshape"
		case .triggers: "bolt"
		case .members: "person.2"
		case .integrations: "puzzlepiece.extension"
		case .billing: "creditcard"
		case .keys: "key"
		case .autonomy: "slider.horizontal.3"
		}
	}
}

/// Your profile, pushed onto the profile sheet's stack.
private struct YourProfilePage: View {
	@State private var store: ProfileStore

	init(environment: AppEnvironment) {
		_store = State(initialValue: SettingsServices(environment: environment).profileStore())
	}

	var body: some View { ProfileView(store: store) }
}

/// A neutral icon tile.
private struct ProfileTile: View {
	static let size: CGFloat = MaskinSpace.s14
	let symbol: String

	var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(MaskinSpace.s10, weight: .semibold)
			.foregroundStyle(MaskinColor.ink2)
			.frame(width: Self.size, height: Self.size)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// One stat tile: the number, a `›` top right, the label, and where it goes in `sigInk`
/// (handoff `7-Chat.md` §10). Pure values in, so it renders in snapshots.
struct ProfileStatTile: View {
	let value: Int
	let label: String
	let destination: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			VStack(alignment: .leading, spacing: 0) {
				HStack(alignment: .top, spacing: MaskinSpace.s2) {
					Text("\(value)")
						.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.w750, relativeTo: .title3))
						.tracking(-0.02 * MaskinFontSize.t20)
						.foregroundStyle(MaskinColor.ink)
						.monospacedDigit()
					Spacer(minLength: 0)
					Text("›")
						.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink5)
				}
				Text(label)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink5)
					.padding(.top, MaskinSpace.s2)
					.fixedSize(horizontal: false, vertical: true)
				Text(destination)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
					.foregroundStyle(MaskinColor.sigInk)
					.padding(.top, MaskinSpace.s3)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s7)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(value) \(label). Opens \(destination)")
	}
}

/// One row: an icon tile, a title over its one-line description, an optional value or unread
/// pill, and a chevron.
private struct ProfileRow: View {
	let title: String
	var subtitle: String?
	let symbol: String
	var value: String?
	var badge: Int = 0
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s8) {
				ProfileTile(symbol: symbol)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(title).maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink).lineLimit(1)
					if let subtitle {
						Text(subtitle)
							.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
							.foregroundStyle(MaskinColor.ink4)
							.lineLimit(1)
					}
				}
				Spacer(minLength: MaskinSpace.s4)
				if let value {
					Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink5).monospacedDigit()
				}
				if badge > 0 { UnreadBadge(count: badge) }
				Image(systemName: "chevron.right")
					.maskinSymbol(MaskinSpace.s7, weight: .semibold)
					.foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.maskinHover()
	}
}

extension View {
	/// A grouped card on the iOS canvas: card surface, continuous corners, hairline border.
	fileprivate func profileCard() -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, lineWidth: 1)
			)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}
