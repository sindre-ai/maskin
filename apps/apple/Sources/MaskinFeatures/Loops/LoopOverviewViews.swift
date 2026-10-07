import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	/// A quiet one-line note on a card (empty states).
	func loopNote() -> some View { loopCard() }
}

private extension View {
	func loopCard() -> some View {
		padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}

/// What a loop or an object produced that is worth presenting: the latest page rendered in
/// place, and any other pages or PDFs as rows. Everything opens full screen.
struct OutcomesSection: View {
	let outputs: [LoopOutput]
	/// Who they came from, named when asking for changes ("from the loop…", "from the task…").
	let sourceName: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var presented: LoopOutput?

	var body: some View {
		if !outputs.isEmpty, let environment = runtime?.environment {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Outcomes") {
					Text("\(outputs.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
				ForEach(Array(outputs.prefix(6).enumerated()), id: \.element.id) { index, output in
					Button { presented = output } label: {
						if index == 0 && output.isHTML {
							OutcomeFeatureCard(
								environment: environment, output: output, height: sizeClass == .regular ? 340 : 220)
						} else {
							OutcomeRow(output: output)
						}
					}
					.buttonStyle(.plain)
					.accessibilityHint("Opens it full screen")
				}
			}
			.sheet(item: $presented) { output in
				OutcomePresenter(environment: environment, output: output, sourceName: sourceName)
			}
		}
	}
}

/// The loop's own briefing cards: the same story cards For you shows, limited to the pages this
/// loop produced. Nothing shows until there is one.
struct LoopBriefingsSection: View {
	let loopID: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var openStory: StoryCard?

	var body: some View {
		if let runtime, let stories = runtime.storiesStore(), !stories.cards(forLoop: loopID).isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Briefings")
				StoryRow(stories: stories, loopID: loopID) { card in openStory = card }
			}
			.storyCover(item: $openStory) { card in
				BriefViewer(
					environment: runtime.environment, stories: stories,
					sequence: BriefSequence.make(cards: stories.cards(forLoop: loopID), opening: card)
				) { openStory = nil }
			}
		}
	}
}

/// What the agents said on the loop's timeline, newest first, in one grouped card.
struct LoopPostsSection: View {
	let posts: [LoopPost]
	let directory: ActorDirectory
	let loopID: String
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var showAll = false

	var body: some View {
		if !posts.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("From the agents") {
					Text("\(posts.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
				let shown = showAll ? posts : Array(posts.prefix(3))
				VStack(spacing: 0) {
					ForEach(Array(shown.enumerated()), id: \.element.id) { index, post in
						row(post)
						if index < shown.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				if posts.count > 3 {
					Button(showAll ? "Show fewer" : "Show all \(posts.count)") { showAll.toggle() }
						.buttonStyle(.plain)
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private func row(_ post: LoopPost) -> some View {
		let actor = directory.actor(post.actorID)
		let name = actor?.name ?? "Someone"
		return VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s4) {
				ActorAvatar(
					name: name, kind: actor?.isAgent == true ? .agent : .human,
					size: MaskinSpace.s11, seed: post.actorID)
				Text(name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: MaskinSpace.s3)
				if post.isDecision {
					Text("Asks you").maskinText(.caption).foregroundStyle(MaskinColor.warningStrong)
				}
				RelativeTime(post.date, style: .compact)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
			Button { runtime?.openObject(loopID) } label: {
				Text(post.text)
					.maskinText(.body).foregroundStyle(MaskinColor.ink)
					.lineLimit(6)
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens the flow's timeline")
			HStack(spacing: MaskinSpace.s6) {
				Button {
					runtime?.buildInChat("About \(name)'s update on this flow: ")
				} label: {
					Label("Discuss", systemImage: "bubble.left")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3)
				}
				.buttonStyle(.plain)
				if post.replyCount > 0 {
					Text("\(post.replyCount) \(post.replyCount == 1 ? "reply" : "replies")")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s7)
	}
}

/// Objects moving through the loop, one chip per status, and what happens in the tapped one.
struct LoopFlowSection: View {
	let store: LoopDetailStore
	var onOpenTrigger: (String) -> Void = { _ in }
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		let phases = store.phases
		if !phases.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("The flow, right now") {
					Text("\(phases.reduce(0) { $0 + $1.count }) objects")
						.maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
				LazyVGrid(
					columns: [GridItem(.adaptive(minimum: 120), spacing: MaskinSpace.s4, alignment: .leading)],
					alignment: .leading, spacing: MaskinSpace.s4
				) {
					ForEach(phases) { chip($0) }
				}
				if let phase = store.selectedPhase { card(phase) }
			}
		}
	}

	private func chip(_ phase: LoopPhase) -> some View {
		let selected = store.selectedPhase?.status == phase.status
		let colors = MaskinStatus.colors(for: phase.status)
		return Button { store.selectedStatus = phase.status } label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(MaskinStatus.label(for: phase.status)).maskinText(.subhead)
				Text("\(phase.count)").maskinText(.mono)
			}
			.foregroundStyle(selected ? colors.fg : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s6)
			.padding(.vertical, MaskinSpace.s4)
			.frame(maxWidth: .infinity)
			.background(selected ? colors.bg : MaskinSurface.card, in: Capsule())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("\(MaskinStatus.label(for: phase.status)), \(phase.count)")
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private func card(_ phase: LoopPhase) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			ForEach(phase.steps) { step in
				Button { onOpenTrigger(step.triggerID) } label: {
					HStack(spacing: MaskinSpace.s4) {
						if let agent = step.agentName {
							ActorAvatar(name: agent, kind: .agent, size: MaskinSpace.s11, seed: step.agentID)
						}
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(step.agentName ?? step.displayName)
								.maskinText(.subhead).foregroundStyle(MaskinColor.ink)
							Text(step.firesSummary).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						}
						Spacer(minLength: 0)
					}
				}
				.buttonStyle(.plain)
				.accessibilityHint("Opens this step's trigger")
			}
			if phase.steps.isEmpty {
				Text("No agent picks this up. It moves when someone changes it.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
			if phase.members.isEmpty {
				Text("Nothing is sitting in this phase.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			} else {
				VStack(spacing: 0) {
					ForEach(Array(phase.members.prefix(8).enumerated()), id: \.element.id) { index, member in
						Button { runtime?.openObject(member.id) } label: {
							HStack(spacing: MaskinSpace.s4) {
								Text(member.title).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
									.lineLimit(2)
								Spacer(minLength: MaskinSpace.s3)
								Image(systemName: "chevron.right")
									.font(.caption).foregroundStyle(MaskinColor.ink5)
							}
							.padding(.vertical, MaskinSpace.s5)
							.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
						if index < min(phase.members.count, 8) - 1 {
							Divider().overlay(MaskinSurface.separator)
						}
					}
					if phase.members.count > 8 {
						Text("+\(phase.members.count - 8) more")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(.top, MaskinSpace.s3)
					}
				}
			}
		}
		.loopCard()
	}
}

/// What the loop wants from you and what it is doing: decisions waiting, objects in motion, and
/// what runs next, all from the loop's own posts, members and steps.
struct LoopActionsSection: View {
	let store: LoopDetailStore
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s12) {
			needsYou
			inMotion
			comingUp
		}
	}

	private var decisions: [LoopPost] { store.posts.filter(\.isDecision) }

	private var needsYou: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Needs you")
			if decisions.isEmpty {
				Text("Nothing needs you on this flow right now.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				ForEach(decisions) { post in
					Button { runtime?.openObject(store.loop.id) } label: {
						VStack(alignment: .leading, spacing: MaskinSpace.s4) {
							HStack {
								MonoLabel("Decision")
								Spacer(minLength: MaskinSpace.s3)
								RelativeTime(post.date, style: .compact)
									.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
							}
							Text(post.text)
								.maskinText(.body).foregroundStyle(MaskinColor.ink)
								.lineLimit(5)
								.frame(maxWidth: .infinity, alignment: .leading)
							Text("Decide ›")
								.maskinText(.subhead).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink3)
								.frame(maxWidth: .infinity, alignment: .trailing)
						}
						.loopCard()
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.accessibilityHint("Opens the flow's timeline")
				}
			}
		}
	}

	/// Members still on their way: everything but those in the workflow's last status.
	private var movingMembers: [LoopMember] {
		let done = store.overview.statusOrder.last
		return store.overview.members.filter { $0.status != done }
	}

	private var inMotion: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("In motion") {
				Text("\(movingMembers.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			if movingMembers.isEmpty {
				Text("Nothing is in flight.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				VStack(spacing: 0) {
					let shown = Array(movingMembers.prefix(8))
					ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
						Button { runtime?.openObject(member.id) } label: {
							HStack(spacing: MaskinSpace.s5) {
								Text(member.title).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
									.lineLimit(2)
								Spacer(minLength: MaskinSpace.s3)
								Text(MaskinStatus.label(for: member.status))
									.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							}
							.padding(.vertical, MaskinSpace.s5)
							.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
						if index < shown.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
					if movingMembers.count > 8 {
						Text("+\(movingMembers.count - 8) more")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding(.vertical, MaskinSpace.s3)
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			}
		}
	}

	/// Scheduled steps in the order they fire, with when; event-driven steps after, with what wakes them.
	private var comingUp: some View {
		let items = LoopComingUp.items(steps: store.steps, now: Date(), paused: store.loop.isPaused)
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Coming up")
			if items.isEmpty {
				Text("This flow runs on its triggers.")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				VStack(spacing: 0) {
					ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
						HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s6) {
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(item.step.displayName).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
								Text(item.step.firesSummary)
									.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							}
							Spacer(minLength: MaskinSpace.s3)
							if let next = item.next {
								Text(next.formatted(date: .abbreviated, time: .shortened))
									.maskinText(.caption).foregroundStyle(MaskinColor.ink3)
									.multilineTextAlignment(.trailing)
							}
						}
						.padding(.vertical, MaskinSpace.s5)
						.accessibilityElement(children: .combine)
						if index < items.count - 1 { Divider().overlay(MaskinSurface.separator) }
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			}
		}
	}
}
