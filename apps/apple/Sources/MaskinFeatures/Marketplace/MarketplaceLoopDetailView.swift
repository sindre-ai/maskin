import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One marketplace loop: what it does, what it bundles, and install / fork / remove.
struct MarketplaceLoopDetailView: View {
	let store: MarketplaceStore
	let loopID: String
	var onOpenLoop: (String) -> Void = { _ in }

	@State private var detail: MarketplaceLoopDetail?
	@State private var loadError: String?
	@State private var confirmRemove = false
	@State private var confirmFork = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				if let detail {
					content(detail)
				} else if let loadError {
					EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load this flow", message: loadError) {
						Button("Try again") { Task { await load() } }.buttonStyle(.secondaryAction)
					}
				} else {
					LoadingSkeleton(rows: 4)
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.navigationTitle(detail?.loop.name ?? "")
		.task { await load() }
		.confirmationDialog("Remove this flow?", isPresented: $confirmRemove, titleVisibility: .visible) {
			if let row = store.install(for: loopID) {
				Button("Remove and keep its agents and triggers") {
					Task { await store.uninstall(row.id, keepProvisionedItems: true) }
				}
				Button("Remove everything it added", role: .destructive) {
					Task { await store.uninstall(row.id, keepProvisionedItems: false) }
				}
			}
			Button("Cancel", role: .cancel) {}
		}
		.confirmationDialog(
			"Fork this flow?", isPresented: $confirmFork, titleVisibility: .visible
		) {
			if let row = store.install(for: loopID) {
				Button("Fork") { Task { await store.fork(row.id) } }
			}
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("A fork is yours to change, and stops following marketplace updates.")
		}
	}

	private func load() async {
		loadError = nil
		do { detail = try await store.detail(loopID: loopID) } catch {
			loadError = (error as? AutomationError)?.message ?? "Something went wrong. Check your connection."
		}
	}

	@ViewBuilder
	private func content(_ detail: MarketplaceLoopDetail) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s4) {
				if let useCase = detail.loop.useCase, !useCase.isEmpty { MonoLabel(useCase) }
				Text("v\(detail.loop.version)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
			}
			Text(detail.loop.name).maskinText(.largeTitle).foregroundStyle(MaskinColor.ink)
			if !detail.loop.summary.isEmpty {
				Text(detail.loop.summary).maskinText(.body).foregroundStyle(MaskinColor.ink2)
			}
		}
		if let notice = store.notice { FormError(notice).onTapGesture { store.notice = nil } }
		actions(detail)
		if !detail.items.isEmpty { includes(detail.items) }
	}

	@ViewBuilder
	private func actions(_ detail: MarketplaceLoopDetail) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			switch store.state(of: loopID) {
			case .notInstalled:
				Button("Install flow") { Task { await store.installLoop(loopID) } }
					.buttonStyle(.primaryAction)
			case .installing:
				HStack(spacing: MaskinSpace.s4) {
					ProgressView()
					Text("Installing…").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				}
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
			case .installed(let row):
				if let note = row.updateNote {
					Text(note)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.warningStrong)
						.padding(MaskinSpace.s8)
						.frame(maxWidth: .infinity, alignment: .leading)
						.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				}
				if let object = row.objectID {
					Button("Open flow") { onOpenLoop(object) }.buttonStyle(.primaryAction)
				}
				HStack(spacing: MaskinSpace.s5) {
					if !row.isForked {
						Button("Fork") { confirmFork = true }.buttonStyle(.secondaryAction)
					}
					Button("Remove") { confirmRemove = true }.buttonStyle(.secondaryAction)
				}
				.disabled(store.busyInstalls.contains(row.id))
				if row.isForked {
					Text("You forked this flow. It no longer follows marketplace updates.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private func includes(_ items: [MarketplaceItem]) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Includes") {
				Text("\(items.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			VStack(spacing: 0) {
				ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
					HStack(alignment: .top, spacing: MaskinSpace.s6) {
						Image(systemName: item.kind.symbol)
							.foregroundStyle(MaskinColor.ink3)
							.frame(width: MaskinSpace.s13)
							.accessibilityHidden(true)
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(item.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
							MonoLabel(item.kind.singularLabel)
							if let summary = item.summary {
								Text(summary).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
							}
						}
						Spacer(minLength: 0)
					}
					.padding(.vertical, MaskinSpace.s6)
					.accessibilityElement(children: .combine)
					if index < items.count - 1 { Divider().overlay(MaskinSurface.separator) }
				}
			}
			.padding(.horizontal, MaskinSpace.s8)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		}
	}
}
