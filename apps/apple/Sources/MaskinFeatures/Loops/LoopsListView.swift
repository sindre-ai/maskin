import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The loops sidebar: sections by what needs attention, with loading, empty, error and offline states.
struct LoopsListView: View {
	let store: LoopsStore
	@Binding var selection: String?
	let search: String
	var isLive = true
	var zoomNamespace: Namespace.ID?
	var onNew: () -> Void = {}
	var onBrowse: () -> Void = {}

	var body: some View {
		let sections = store.sections(query: search)
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if let notice = store.notice {
				FormError(notice)
					.listRowBackground(Color.clear)
					.onTapGesture { store.notice = nil }
			}
			if search.isEmpty, let summary = store.summaryLine {
				Text(summary)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
					.listRowSeparator(.hidden)
					.listRowBackground(Color.clear)
			}
			ForEach(sections) { section in
				Section {
					ForEach(section.items) { loop in
						let digest = store.digests[loop.id]
						LoopCard(
							loop: loop, digest: digest,
							authorName: store.directory.name(digest?.latestAuthorID),
							agentCount: loop.agentIDs.count, needsYou: store.needsYou(loop),
							hasUpdate: store.installs[loop.id]?.hasUpdate == true
						)
						.tag(loop.id)
						.zoomSource(id: loop.id, in: zoomNamespace)
						.listRowSeparator(.hidden)
						.listRowBackground(Color.clear)
						.listRowInsets(
							EdgeInsets(
								top: MaskinSpace.s3, leading: MaskinSpace.s7, bottom: MaskinSpace.s3,
								trailing: MaskinSpace.s7))
						.swipeActions(edge: .trailing, allowsFullSwipe: true) {
							if loop.status != .draft {
								Button {
									Task { await store.togglePause(loop.id) }
								} label: {
									Label(loop.isPaused ? "Resume" : "Pause", systemImage: loop.isPaused ? "play.fill" : "pause.fill")
								}
								.tint(loop.isPaused ? MaskinColor.success : MaskinColor.ink4)
							}
						}
					}
				} header: {
					Text(section.label)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3).textCase(nil)
				}
			}
		}
		.listStyle(.plain)
		.background(MaskinSurface.grouped)
		.task(id: store.loops.map { "\($0.id)\($0.updatedAt?.timeIntervalSince1970 ?? 0)" }) {
			await store.loadDigests()
		}
		.overlay { overlay(isEmpty: sections.isEmpty) }
		.refreshable { await store.refresh() }
	}

	@ViewBuilder
	private func overlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.loops.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load loops", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "arrow.triangle.2.circlepath", title: "No loops running",
						message: "A loop is a few agents working together. Describe one in chat, or pick one from the marketplace."
					) {
						VStack(spacing: MaskinSpace.s5) {
							Button("Build a loop in chat", action: onNew).buttonStyle(.primaryAction)
							Button("Browse marketplace", action: onBrowse).buttonStyle(.secondaryAction)
						}
						.frame(maxWidth: 320)
					}
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}
