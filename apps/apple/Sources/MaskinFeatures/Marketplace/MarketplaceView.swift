import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The marketplace as a sheet: browse loops other teams built, open one for what it bundles, and
/// install it. `onOpenLoop` receives the new loop's object id so the Loops tab can show it.
public struct MarketplaceSheet: View {
	private let environment: AppEnvironment
	private let workspaceID: String
	private let onInstalled: () -> Void
	private let onOpenLoop: (String) -> Void
	@State private var store: MarketplaceStore

	public init(
		environment: AppEnvironment, workspaceID: String, onInstalled: @escaping () -> Void = {},
		onOpenLoop: @escaping (String) -> Void
	) {
		self.environment = environment
		self.workspaceID = workspaceID
		self.onInstalled = onInstalled
		self.onOpenLoop = onOpenLoop
		_store = State(
			initialValue: MarketplaceStore(
				api: APIMarketplaceSource(client: environment.client, workspaceID: workspaceID)))
	}

	public var body: some View {
		MarketplaceContent(store: store, onOpenLoop: onOpenLoop)
			.task {
				store.onLoopsChanged = onInstalled
				await store.load()
			}
	}
}

/// Catalog + detail navigation over a store (separate from the sheet so tests can render it).
struct MarketplaceContent: View {
	let store: MarketplaceStore
	let onOpenLoop: (String) -> Void

	@Environment(\.dismiss) private var dismiss
	@Environment(\.isPushedInHostStack) private var pushed
	@State private var search = ""
	@State private var path: [String] = []

	var body: some View {
		if pushed {
			catalog.navigationDestination(item: openLoopID) { detail($0) }
		} else {
			NavigationStack(path: $path) {
				catalog
					.toolbar {
						ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
					}
					.navigationDestination(for: String.self) { detail($0) }
			}
		}
	}

	/// The open loop as an optional, for the pushed layout that has no path-driven stack of its own.
	private var openLoopID: Binding<String?> {
		Binding(get: { path.last }, set: { if $0 == nil { path.removeAll() } else { path = [$0!] } })
	}

	private var catalog: some View {
		catalogList
			.ambientBackground()
			.navigationTitle("Marketplace")
			#if os(iOS)
			.toolbarTitleDisplayMode(.inlineLarge)
			#endif
			.searchable(text: $search, prompt: "Search the marketplace")
	}

	private func detail(_ id: String) -> some View {
		MarketplaceLoopDetailView(
			store: store, loopID: id,
			onOpenLoop: { object in
				dismiss()
				onOpenLoop(object)
			})
	}

	/// v19: Update available, Installed, then the catalog under its use-case headings.
	private var catalogList: some View {
		let updates = store.updatesAvailable.filter { matches($0) }
		let installed = store.installedEntries(query: search)
		let groups = store.catalogGroups(query: search)
		return ScrollView {
			LazyVStack(alignment: .leading, spacing: MaskinSpace.s9) {
				if let notice = store.notice {
					FormError(notice).onTapGesture { store.notice = nil }
				}
				if !updates.isEmpty {
					PageGroupLabel(text: "Update available")
					PageCard(rows: updates.map(updateRow))
				}
				if !installed.isEmpty {
					PageGroupLabel(text: "Installed")
					PageCard(rows: installed.map(installedRow))
				}
				ForEach(groups) { group in
					PageGroupLabel(text: group.title)
					PageCard(rows: group.loops.map(catalogRow))
				}
				stateOverlay(isEmpty: installed.isEmpty && groups.isEmpty)
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 1000)
			.frame(maxWidth: .infinity)
		}
		.refreshable { await store.load() }
	}

	private func matches(_ row: InstalledLoop) -> Bool {
		search.isEmpty || store.installedEntries(query: search).contains { $0.id == row.id }
	}

	private func updateRow(_ row: InstalledLoop) -> PageRowModel {
		PageRowModel(
			id: "update-\(row.id)", title: "\(row.loopName) v\(row.availableVersion)", subtitle: row.updateNote,
			showsChevron: true, action: { path.append(row.sourceLoopID) })
	}

	private func installedRow(_ entry: MarketplaceStore.InstalledEntry) -> PageRowModel {
		PageRowModel(
			id: "installed-\(entry.id)", title: entry.loop?.name ?? entry.install.loopName,
			subtitle: Self.line(entry.loop),
			accessory: .state(PageState("v\(entry.install.installedVersion)", .muted)),
			showsChevron: true, action: { path.append(entry.install.sourceLoopID) })
	}

	private func catalogRow(_ loop: MarketplaceLoop) -> PageRowModel {
		PageRowModel(
			id: loop.id, title: loop.name, subtitle: Self.line(loop), showsChevron: true,
			action: { path.append(loop.id) })
	}

	/// "Engineering · 6 agents · 2 triggers": only what the catalog actually lists.
	static func line(_ loop: MarketplaceLoop?) -> String? {
		guard let loop else { return nil }
		let parts = [loop.useCase, loop.contentsLine].compactMap { $0 }.filter { !$0.isEmpty }
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
	}

	@ViewBuilder
	private func stateOverlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.catalog.isEmpty { LoadingSkeleton(rows: 4) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load the marketplace", message: message) {
				Button("Try again") { Task { await store.load() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "square.grid.2x2", title: "Nothing here yet",
						message: "The marketplace has no flows right now.")
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}

/// One catalog loop: big rounded card, name, what it does, what it bundles, install state.
struct MarketplaceCard: View {
	let loop: MarketplaceLoop
	let state: MarketplaceInstallState
	var onInstall: () -> Void = {}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(alignment: .firstTextBaseline) {
				Text(MarketplaceKind.flowTag)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.vertical, MaskinSpace.s1)
					.background(MaskinSurface.fill, in: Capsule())
				if let useCase = loop.useCase, !useCase.isEmpty { MonoLabel(useCase) }
				Spacer(minLength: 0)
				Text("v\(loop.version)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
			}
			Text(loop.name).maskinText(.title).foregroundStyle(MaskinColor.ink).lineLimit(2)
				.multilineTextAlignment(.leading)
			if !loop.summary.isEmpty {
				Text(loop.summary).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
					.lineLimit(3).multilineTextAlignment(.leading)
			}
			Spacer(minLength: 0)
			HStack(spacing: MaskinSpace.s4) {
				if !loop.contentsLine.isEmpty {
					Text(loop.contentsLine).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
				Spacer(minLength: 0)
				InstallBadge(state: state, onInstall: onInstall)
			}
		}
		.frame(maxWidth: .infinity, minHeight: 170, alignment: .leading)
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.contentShape(Rectangle())
		.accessibilityElement(children: .contain)
	}
}

/// "Install" capsule, a spinner while installing, or "Installed" (with an update dot).
struct InstallBadge: View {
	let state: MarketplaceInstallState
	var onInstall: () -> Void = {}

	var body: some View {
		switch state {
		case .notInstalled:
			Button(action: onInstall) {
				Text("Install")
					.maskinText(.subhead)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8)
					.padding(.vertical, MaskinSpace.s4)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.maskinPressed(.shrink))
		case .installing:
			ProgressView().controlSize(.small)
		case .installed(let row):
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: row.hasUpdate ? "arrow.up.circle.fill" : "checkmark")
					.accessibilityHidden(true)
				Text(row.hasUpdate ? "Update" : "Installed")
			}
			.maskinText(.subhead)
			.foregroundStyle(row.hasUpdate ? MaskinColor.sigInk : MaskinColor.doneFg)
		}
	}
}
