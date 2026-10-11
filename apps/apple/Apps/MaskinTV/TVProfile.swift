import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The account on the big screen: profile and workspace card, the Workspace rows (Agents,
/// Marketplace, Artefacts) and You rows (Settings, Autonomy), then Log out. Each row opens a list
/// screen with the same row pattern. Switching workspace resets the app to For you.
struct TVProfile: View {
	let environment: AppEnvironment
	let resetToForYou: () -> Void
	@State private var confirmingLogOut = false

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 36) {
					Text("Profile").font(.system(size: 64, weight: .bold))
					account
					section(.workspace)
					section(.you)
					Button { confirmingLogOut = true } label: {
						TVCapsuleLabel(title: "Log out", symbol: "rectangle.portrait.and.arrow.right")
							.foregroundStyle(MaskinColor.danger)
					}
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					.frame(maxWidth: 560)
					.padding(.top, 16)
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: TVProfileRow.self) { row in
				TVProfileList(environment: environment, row: row)
			}
		}
		.confirmationDialog("Log out of Maskin?", isPresented: $confirmingLogOut, titleVisibility: .visible) {
			Button("Log out", role: .destructive) { environment.signOut() }
			Button("Cancel", role: .cancel) {}
		}
	}

	@ViewBuilder private var account: some View {
		let workspaces = environment.workspaces
		if let session = environment.auth.session {
			VStack(alignment: .leading, spacing: 8) {
				Text(session.name).font(.system(size: 40, weight: .bold))
				if let email = session.email {
					Text(email).font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		label("WORKSPACE")
		VStack(spacing: 20) {
			ForEach(workspaces.workspaces) { workspace in
				Button {
					guard workspace.id != workspaces.selectedID else { return }
					workspaces.select(workspace.id)
					resetToForYou()
				} label: {
					TVListRow(
						title: workspace.name, meta: nil,
						trailing: workspace.id == workspaces.selectedID ? .symbol("checkmark") : .none)
				}
				.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
			}
		}
	}

	private func section(_ section: TVProfileRow.Section) -> some View {
		VStack(alignment: .leading, spacing: 20) {
			if section == .you { label("YOU") }
			ForEach(TVProfileRow.rows(in: section)) { row in
				NavigationLink(value: row) {
					TVListRow(title: row.title, meta: nil, trailing: .symbol("chevron.right"), symbol: row.symbol)
				}
				.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
			}
		}
	}

	private func label(_ text: String) -> some View {
		Text(text).font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
	}
}

/// The one row pattern every Profile list uses: title, meta line, trailing value.
struct TVListRow: View {
	enum Trailing { case none, text(String), symbol(String), toggle(Bool) }

	let title: String
	let meta: String?
	var trailing: Trailing = .none
	var symbol: String?

	var body: some View {
		HStack(spacing: 24) {
			if let symbol { Image(systemName: symbol).font(.system(size: 30)).frame(width: 48) }
			VStack(alignment: .leading, spacing: 6) {
				Text(title).font(.system(size: 32, weight: .semibold)).lineLimit(1)
				if let meta, !meta.isEmpty {
					Text(meta).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
			}
			Spacer(minLength: 0)
			switch trailing {
			case .none: EmptyView()
			case .text(let value): Text(value).font(.system(size: 28)).foregroundStyle(MaskinColor.ink3)
			case .symbol(let name): Image(systemName: name).font(.system(size: 28, weight: .bold)).foregroundStyle(MaskinColor.ink3)
			case .toggle(let on):
				Text(on ? "On" : "Off").font(.system(size: 28, weight: .semibold))
					.foregroundStyle(on ? MaskinColor.ink : MaskinColor.ink4)
			}
		}
		.padding(.horizontal, 36)
		.frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
		.foregroundStyle(MaskinColor.ink)
	}
}

/// A Profile row's list screen. Agents, Marketplace and Artefacts are listed only (open or change
/// them on iPhone or iPad); Settings and Autonomy rows are On/Off toggles.
private struct TVProfileList: View {
	let environment: AppEnvironment
	let row: TVProfileRow
	@State private var agents: AgentsStore?
	@State private var marketplace: MarketplaceStore?
	@State private var files: FilesListStore?
	@State private var autonomy: AutonomyStore?
	@AppStorage(TVNarrator.narrateKey) private var narrate = true

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 32) {
				Text(row.title).font(.system(size: 64, weight: .bold))
				VStack(spacing: 20) { content }
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.task { await start() }
	}

	@ViewBuilder private var content: some View {
		switch row {
		case .agents:
			if let agents {
				ForEach(agents.agents) { agent in
					TVListRow(title: agent.name, meta: agent.role, trailing: .text(agent.status.label)).focusable()
				}
				empty(agents.agents.isEmpty && agents.phase == .loaded, "No agents yet")
			}
		case .marketplace:
			if let marketplace {
				ForEach(marketplace.catalog) { loop in
					TVListRow(title: loop.name, meta: loop.summary, trailing: .text("v\(loop.version)")).focusable()
				}
				empty(marketplace.catalog.isEmpty && marketplace.phase == .loaded, "Nothing in the marketplace")
			}
		case .artefacts:
			if let files {
				ForEach(files.files) { file in
					TVListRow(title: file.name, meta: file.description, trailing: .text(file.mimeType)).focusable()
				}
				empty(files.files.isEmpty && files.phase == .loaded, "No artefacts yet")
				Text("Open or change a page on iPhone or iPad.")
					.font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
			}
		case .settings:
			Button { narrate.toggle() } label: {
				TVListRow(title: "Narrate briefings", meta: "Read each slide aloud", trailing: .toggle(narrate))
			}
			.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
		case .autonomy:
			if let autonomy {
				ForEach(AutonomyLevel.allCases) { level in
					Button { autonomy.select(level) } label: {
						TVListRow(title: level.title, meta: level.summary, trailing: .toggle(autonomy.level == level))
					}
					.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
				}
				if let line = autonomy.changeLine {
					Text(line).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	@ViewBuilder private func empty(_ show: Bool, _ title: String) -> some View {
		if show { EmptyState(symbol: row.symbol, title: title) }
	}

	private func start() async {
		guard let workspaceID = environment.workspaceId else { return }
		let credentials = environment.auth.credentialsProvider
		switch row {
		case .agents:
			let store = AgentsStore(
				api: APIAgentsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache)
			agents = store
			await store.start()
		case .marketplace:
			let store = MarketplaceStore(api: APIMarketplaceSource(client: environment.client, workspaceID: workspaceID))
			marketplace = store
			await store.load()
		case .artefacts:
			let store = FilesListStore(remote: APIFilesRemote(client: environment.client, credentials: credentials))
			files = store
			await store.load()
		case .autonomy:
			autonomy = AutonomyStore(
				workspaceID: workspaceID, actorID: environment.auth.session?.actorId ?? "",
				storage: UserDefaultsAutonomyStorage())
		case .settings:
			break
		}
	}
}
