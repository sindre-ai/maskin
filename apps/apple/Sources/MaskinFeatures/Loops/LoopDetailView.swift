import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One loop: state and pause/resume, stats, the step pipeline (trigger → agent → hand-off) and
/// recent agent activity.
struct LoopDetailView: View {
	let store: LoopDetailStore
	var install: LoopInstall?
	var onOpenTrigger: (String) -> Void = { _ in }

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var confirmDelete = false

	var body: some View {
		ScrollView {
			LoopDetailContent(store: store, install: install, onOpenTrigger: onOpenTrigger)
				.padding(MaskinSpace.s9)
				.frame(maxWidth: 720, alignment: .leading)
				.frame(maxWidth: .infinity)
		}
		.background(MaskinSurface.grouped)
		.navigationTitle(store.loop.displayName)
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.refreshable { await store.refresh() }
		.toolbar {
			if store.loop.status != .draft {
				ToolbarItem(placement: .primaryAction) {
					Button {
						Task { await store.togglePause() }
					} label: {
						Label(
							store.loop.isPaused ? "Resume" : "Pause",
							systemImage: store.loop.isPaused ? "play.fill" : "pause.fill")
					}
					.disabled(store.isTogglingPause)
				}
			}
			ToolbarItem(placement: .primaryAction) {
				Menu {
					Button {
						runtime?.buildInChat("I'd like to change the loop \(store.loop.displayName). ")
					} label: { Label("Change in chat", systemImage: "bubble.left") }
					Button(role: .destructive) { confirmDelete = true } label: {
						Label("Delete loop", systemImage: "trash")
					}
				} label: {
					Label("More", systemImage: "ellipsis.circle")
				}
			}
		}
		.confirmationDialog(
			"Delete this loop?", isPresented: $confirmDelete, titleVisibility: .visible
		) {
			Button("Delete loop", role: .destructive) { Task { await store.delete() } }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("Its agents and triggers stay. This can't be undone.")
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
	}

}

/// The loop detail body without its scroll view (so it can be rendered offscreen in tests).
struct LoopDetailContent: View {
	let store: LoopDetailStore
	var install: LoopInstall?
	var onOpenTrigger: (String) -> Void = { _ in }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s12) {
			header
			LoopOutputsSection(outputs: store.outputs, loop: store.loop)
			LoopPostsSection(posts: store.posts, directory: store.directory, loopID: store.loop.id)
			LoopFlowSection(store: store, onOpenTrigger: onOpenTrigger)
			stats
			pipeline
			activity
		}
	}

	// MARK: Sections

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s4) {
				LoopPillView(pill: store.loop.pill)
				RelativeTime(store.loop.updatedAt)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink5)
			}
			Text(store.verdict).maskinText(.headline).foregroundStyle(MaskinColor.ink)
			if let content = store.loop.content, !content.isEmpty {
				Text(content).maskinText(.body).foregroundStyle(MaskinColor.ink2)
			}
			if let notice = store.notice {
				FormError(notice).onTapGesture { store.notice = nil }
			}
			if let install, install.hasUpdate {
				Text(
					install.isForked
						? "v\(install.availableVersion) of the source is available. Your fork keeps its own version."
						: "Update to v\(install.availableVersion) available. Open the marketplace to review it."
				)
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.warningStrong)
				.padding(MaskinSpace.s8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			}
			conditions
		}
	}

	@ViewBuilder
	private var conditions: some View {
		let rows = [("Starts when", store.loop.entryCondition), ("Done when", store.loop.closeCondition)]
			.compactMap { label, value in value.flatMap { $0.isEmpty ? nil : (label, $0) } }
		if !rows.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				ForEach(rows, id: \.0) { label, value in
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						MonoLabel(label)
						Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
					}
				}
			}
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		}
	}

	private var stats: some View {
		let tiles: [(String, String)] = [
			("In progress", "\(store.loop.inProgressCount)"),
			("Closed", "\(store.loop.closedCount)"),
			("Waiting on you", "\(store.loop.waitingCount)"),
			("Median time", store.loop.medianTimeToClose.map(LoopDurationText.string) ?? "—"),
		]
		return LazyVGrid(
			columns: [GridItem(.adaptive(minimum: 150), spacing: MaskinSpace.s5)], spacing: MaskinSpace.s5
		) {
			ForEach(tiles, id: \.0) { label, value in
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					MonoLabel(label)
					Text(value).maskinText(.title).foregroundStyle(MaskinColor.ink)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.accessibilityElement(children: .combine)
			}
		}
	}

	private var pipeline: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Steps") {
				Text("\(store.steps.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			switch store.phase {
			case .idle where store.steps.isEmpty, .loading where store.steps.isEmpty:
				LoadingSkeleton(rows: 3)
			case .failed(let message) where store.steps.isEmpty:
				EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load steps", message: message) {
					Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
				}
			default:
				if store.steps.isEmpty {
					Text("This loop has no steps yet.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				} else {
					VStack(spacing: 0) {
						ForEach(Array(store.steps.enumerated()), id: \.element.id) { index, step in
							LoopStepRow(
								number: index + 1, step: step, isLast: index == store.steps.count - 1,
								onOpen: { onOpenTrigger(step.triggerID) })
						}
					}
				}
			}
		}
	}

	/// Latest first, so the newest run is on screen without scrolling. Undated entries go last.
	private func newestFirst(_ entries: [LoopActivityEntry]) -> [LoopActivityEntry] {
		entries.enumerated().sorted {
			let a = $0.element.createdAt ?? .distantPast, b = $1.element.createdAt ?? .distantPast
			return a != b ? a > b : $0.offset < $1.offset
		}.map(\.element)
	}

	private var activity: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Recent activity")
			if store.activity.isEmpty {
				Text(store.phase == .loaded ? "Nothing has run yet." : "")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					let recent = Array(newestFirst(store.activity).prefix(20))
					ForEach(Array(recent.enumerated()), id: \.element.id) { index, entry in
						LoopActivityRow(entry: entry, actorName: store.actorName(entry))
						if index < recent.count - 1 {
							Divider().overlay(MaskinSurface.separator)
						}
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			}
		}
	}
}

/// One step of the pipeline, joined to the next by a rail.
struct LoopStepRow: View {
	let number: Int
	let step: LoopStep
	let isLast: Bool
	var onOpen: () -> Void = {}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			VStack(spacing: 0) {
				Text("\(number)")
					.maskinText(.caption)
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
					.background(MaskinSurface.inverse, in: Circle())
				if !isLast {
					Rectangle().fill(MaskinSurface.line).frame(width: 2).frame(maxHeight: .infinity)
				}
			}
			.accessibilityHidden(true)
			Button(action: onOpen) {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(alignment: .firstTextBaseline) {
						Text(step.displayName).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						Spacer(minLength: MaskinSpace.s3)
						if step.pendingCount > 0 {
							Text("\(step.pendingCount) waiting")
								.maskinText(.caption).foregroundStyle(MaskinColor.warningStrong)
						}
					}
					label("Fires", step.firesSummary)
					if let agent = step.agentName {
						HStack(spacing: MaskinSpace.s4) {
							ActorAvatar(name: agent, kind: .agent, size: MaskinSpace.s11, seed: step.agentID)
							Text(agent).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
						}
						.accessibilityElement(children: .combine)
						.accessibilityLabel("Runs on \(agent)")
					}
					if let next = step.handsOffName { label("Hands off to", next) }
					if let esc = step.escalatesToName {
						label("Escalates to", esc + (step.escalateAfter.map { " after \(LoopDurationText.string($0))" } ?? ""))
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens this step's trigger")
			.padding(.bottom, isLast ? 0 : MaskinSpace.s5)
		}
	}

	private func label(_ title: String, _ value: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			MonoLabel(title)
			Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
		}
	}
}

/// One line of the activity feed.
struct LoopActivityRow: View {
	let entry: LoopActivityEntry
	let actorName: String?

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Circle().fill(color).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(entry.title).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				if let actorName {
					Text(actorName).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			RelativeTime(entry.createdAt, style: .compact)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.padding(.vertical, MaskinSpace.s5)
		.accessibilityElement(children: .combine)
	}

	private var color: Color {
		switch entry.tone {
		case .success: MaskinColor.success
		case .failure: MaskinColor.danger
		case .active: MaskinColor.accent
		case .neutral: MaskinColor.ink5
		}
	}
}
