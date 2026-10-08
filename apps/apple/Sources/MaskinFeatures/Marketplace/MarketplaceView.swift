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
	@State private var useCase: String?
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
			.searchable(text: $search, prompt: "Search flows")
	}

	private func detail(_ id: String) -> some View {
		MarketplaceLoopDetailView(
			store: store, loopID: id,
			onOpenLoop: { object in
				dismiss()
				onOpenLoop(object)
			})
	}

	private var catalogList: some View {
		let rows = store.loops(useCase: useCase, query: search)
		return ScrollView {
			LazyVStack(alignment: .leading, spacing: MaskinSpace.s9) {
				if let notice = store.notice {
					FormError(notice).onTapGesture { store.notice = nil }
				}
				if !store.updatesAvailable.isEmpty, search.isEmpty, useCase == nil { updates }
				if !store.useCases.isEmpty { chips }
				LazyVGrid(
					columns: [GridItem(.adaptive(minimum: 300), spacing: MaskinSpace.s7)],
					spacing: MaskinSpace.s7
				) {
					ForEach(rows) { loop in
						MarketplaceCard(
							loop: loop, state: store.state(of: loop.id),
							onInstall: { Task { await store.installLoop(loop.id) } }
						)
						.onTapGesture { path.append(loop.id) }
						.accessibilityAddTraits(.isButton)
					}
				}
				stateOverlay(isEmpty: rows.isEmpty)
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 1000)
			.frame(maxWidth: .infinity)
		}
		.refreshable { await store.load() }
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
				if search.isEmpty && useCase == nil {
					EmptyState(
						symbol: "square.grid.2x2", title: "Nothing here yet",
						message: "The marketplace has no flows right now.")
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}

	private var chips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				chip("All", selected: useCase == nil) { useCase = nil }
				ForEach(store.useCases, id: \.self) { name in
					chip(name, selected: useCase == name) { useCase = (useCase == name) ? nil : name }
				}
			}
		}
		.scrollClipDisabled()
	}

	private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.maskinText(.subhead)
				.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink2)
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.vertical, MaskinSpace.s4)
				.background(selected ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
				.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: selected ? 0 : 1))
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private var updates: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			SectionHeader("Updates available") {
				Text("\(store.updatesAvailable.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			ForEach(store.updatesAvailable) { row in
				Button { path.append(row.sourceLoopID) } label: {
					HStack(spacing: MaskinSpace.s5) {
						Image(systemName: "arrow.triangle.2.circlepath")
							.foregroundStyle(MaskinColor.sigInk)
							.accessibilityHidden(true)
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(row.loopName).maskinText(.headline).foregroundStyle(MaskinColor.ink)
							Text(row.updateNote ?? "").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						}
						Spacer(minLength: 0)
						Image(systemName: "chevron.right").foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					.padding(MaskinSpace.s8)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				}
				.buttonStyle(.maskinPressed(.shrink))
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
