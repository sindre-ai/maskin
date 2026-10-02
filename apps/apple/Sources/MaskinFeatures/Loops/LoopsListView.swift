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
			ForEach(sections) { section in
				Section {
					ForEach(section.items) { loop in
						LoopRow(
							loop: loop, agentNames: store.agentNames(for: loop),
							hasUpdate: store.installs[loop.id]?.hasUpdate == true
						)
						.tag(loop.id)
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
					SectionHeader(section.label) {
						Text("\(section.items.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
					}
				}
			}
		}
		.listStyle(.plain)
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
						symbol: "arrow.triangle.2.circlepath", title: "No loops yet",
						message: "Loops are pipelines of agents. Install one from the Maskin web app and it will show up here.")
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}
