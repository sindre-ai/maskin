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
	@State private var underTheHood = false
	@State private var draft = ""
	@State private var dictating = false

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				LoopDetailContent(
					store: store, install: install, underTheHood: underTheHood, onOpenTrigger: onOpenTrigger)
				if underTheHood { manage }
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 720, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		.navigationTitle(store.loop.displayName)
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.refreshable { await store.refresh() }
		.safeAreaInset(edge: .bottom, spacing: 0) { composer }
		.toolbar {
			// One gear: it opens the Under the hood page (and closes it again).
			ToolbarItem(placement: .primaryAction) {
				Button {
					withAnimation(MaskinMotion.quick) { underTheHood.toggle() }
				} label: {
					Label("Under the hood", systemImage: underTheHood ? "gearshape.fill" : "gearshape")
				}
				.accessibilityValue(underTheHood ? "On" : "Off")
			}
		}
		.confirmationDialog(
			"Delete this flow?", isPresented: $confirmDelete, titleVisibility: .visible
		) {
			Button("Delete flow", role: .destructive) { Task { await store.delete() } }
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("Its agents and triggers stay. This can't be undone.")
		}
		.task { await store.start() }
		// The loop's briefing cards come from the store For you shares; load it if nothing has yet.
		.task {
			if let stories = runtime?.storiesStore(), !stories.hasLoaded { await stories.load() }
		}
		.onDisappear { store.stop() }
	}

	/// What the nav menu used to hold, now at the foot of Under the hood: pause or resume, change the
	/// flow in chat, delete it.
	private var manage: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Manage")
			VStack(spacing: 0) {
				if store.loop.status != .draft {
					manageRow(
						store.loop.isPaused ? "Resume flow" : "Pause flow",
						symbol: store.loop.isPaused ? "play.fill" : "pause.fill"
					) { Task { await store.togglePause() } }
						.disabled(store.isTogglingPause)
					Divider().overlay(MaskinSurface.separator)
				}
				manageRow("Change in chat", symbol: "bubble.left") {
					runtime?.buildInChat("I'd like to change the flow \(store.loop.displayName). ")
				}
				Divider().overlay(MaskinSurface.separator)
				manageRow("Delete flow", symbol: "trash", destructive: true) { confirmDelete = true }
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		}
	}

	private func manageRow(
		_ title: String, symbol: String, destructive: Bool = false, action: @escaping () -> Void
	) -> some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: symbol).frame(width: MaskinSpace.s11)
				Text(title).maskinText(.body)
				Spacer(minLength: 0)
			}
			.foregroundStyle(destructive ? MaskinColor.danger : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s9)
			.frame(minHeight: 44)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}

	/// "Change this flow by talking...": hands what you type to a new chat about this flow.
	private var composer: some View {
		GlassComposer(
			text: $draft, placeholder: "Change this flow by talking…",
			onAttach: { startChat("") },
			onSend: {
				let text = draft
				draft = ""
				startChat(text)
			},
			listening: $dictating, mic: { DictationButton(text: $draft, listening: $dictating) }
		)
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s3)
	}

	private func startChat(_ text: String) {
		runtime?.buildInChat("I'd like to change the flow \(store.loop.displayName). \(text)")
	}
}

/// The loop page's three tabs.
enum LoopDetailTab: String, CaseIterable, Identifiable {
	case outcome = "Outcomes"
	case actions = "Actions"
	case activity = "Activity"
	var id: String { rawValue }
}

/// The loop detail body without its scroll view (so it can be rendered offscreen in tests): a
/// header, then Outcome / Actions / Activity. "Under the hood" swaps the tabs for the loop's
/// plumbing (flow, conditions, stats, steps).
struct LoopDetailContent: View {
	let store: LoopDetailStore
	var install: LoopInstall?
	var underTheHood = false
	var onOpenTrigger: (String) -> Void = { _ in }
	@State private var tab: LoopDetailTab

	init(
		store: LoopDetailStore, install: LoopInstall? = nil, underTheHood: Bool = false,
		initialTab: LoopDetailTab = .outcome, onOpenTrigger: @escaping (String) -> Void = { _ in }
	) {
		self.store = store
		self.install = install
		self.underTheHood = underTheHood
		self.onOpenTrigger = onOpenTrigger
		_tab = State(initialValue: initialTab)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s10) {
			header
			if let problem = store.problem() {
				LoopProblemBanner(problem: problem, loop: store.loop, directory: store.directory)
			}
			if underTheHood {
				LoopHoodSection(store: store, onOpenTrigger: onOpenTrigger)
			} else {
				Picker("Show", selection: $tab) {
					ForEach(LoopDetailTab.allCases) { Text($0.rawValue).tag($0) }
				}
				.pickerStyle(.segmented)
				switch tab {
				case .outcome:
					LoopTargetsSection(
						cards: LoopOutcomes.cards(for: store.loop), directory: store.directory)
					LoopBriefingsSection(loopID: store.loop.id)
					LoopQualitySection(loop: store.loop, failedSteps: store.failedSteps())
					OutcomesSection(
						outputs: store.outputs, sourceName: store.loop.displayName, producesStyle: true)
					if store.outputs.isEmpty { emptyNote("Nothing produced yet. Pages and PDFs this flow makes land here.") }
				case .actions:
					LoopActionsSection(store: store)
				case .activity:
					LoopPostsSection(posts: store.posts, directory: store.directory, loopID: store.loop.id)
					activity
				}
			}
		}
	}

	private func emptyNote(_ text: String) -> some View {
		Text(text)
			.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			.loopNote()
	}

	// MARK: Sections

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			HStack(alignment: .top, spacing: MaskinSpace.s9) {
				LoopProgressRing(
					loop: store.loop, size: MaskinSpace.s14 * 2 + MaskinSpace.s4 + MaskinSpace.s1,
					lineWidth: MaskinSpace.s3,
					valueFont: MaskinTypeface.mono(MaskinFontSize.t15, weight: .semibold))
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text(store.loop.displayName)
						.maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text("\(store.loop.cycleLabel) · \(store.loop.pill.label)")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink5)
					stateLine.padding(.top, MaskinSpace.s3)
				}
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
				.foregroundStyle(MaskinColor.noticeFg2)
				.padding(MaskinSpace.s8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(
					MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			}
		}
	}

	/// One line of how the flow is doing: a Patina dot while it runs, grey while it is stopped.
	private var stateLine: some View {
		HStack(spacing: MaskinSpace.s3) {
			Circle()
				.fill(store.loop.pill.isLive ? MaskinColor.sig : MaskinColor.ink5)
				.frame(width: MaskinSpace.s3 + MaskinSpace.s1, height: MaskinSpace.s3 + MaskinSpace.s1)
			Text(store.verdict)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.semibold, relativeTo: .subheadline))
				.foregroundStyle(store.loop.pill.isLive ? MaskinColor.sigInk : MaskinColor.ink4)
		}
		.accessibilityElement(children: .combine)
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
			FlowSectionHeader("Recent activity")
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
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
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
								.maskinText(.caption).foregroundStyle(MaskinColor.sigInk)
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
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
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
		case .success: MaskinColor.ink
		case .failure: MaskinColor.warning
		case .active: MaskinColor.sig
		case .neutral: MaskinColor.ink5
		}
	}
}
