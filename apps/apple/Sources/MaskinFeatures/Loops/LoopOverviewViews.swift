import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	func loopCard() -> some View {
		padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
	}
}

/// The flow page's section label: 12px mono, +0.08em, inset to line up with the cards' text.
struct FlowSectionHeader<Trailing: View>: View {
	private let title: String
	private let trailing: Trailing

	init(_ title: String, @ViewBuilder trailing: () -> Trailing) {
		self.title = title
		self.trailing = trailing()
	}

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(title.uppercased())
				.maskinText(.microLabelLarge)
				.foregroundStyle(MaskinColor.ink5)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s4)
			trailing
		}
		.padding(.horizontal, MaskinSpace.s3)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(title)
		.accessibilityAddTraits(.isHeader)
	}
}

extension FlowSectionHeader where Trailing == EmptyView {
	init(_ title: String) { self.init(title) { EmptyView() } }
}

extension View {
	/// A quiet one-line note on a card (empty states).
	func loopNote() -> some View { loopCard() }
}

/// What a loop or an object produced that is worth presenting: the latest page rendered in
/// place, and any other pages or PDFs as rows. Everything opens full screen.
struct OutcomesSection: View {
	let outputs: [LoopOutput]
	/// Who they came from, named when asking for changes ("from the loop…", "from the task…").
	let sourceName: String
	/// On a flow's Outcome tab the section reads WHAT IT PRODUCES and the rows share one card;
	/// elsewhere (objects) it keeps the plain OUTCOMES header and separate rows.
	var producesStyle = false
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var presented: LoopOutput?

	var body: some View {
		if !outputs.isEmpty, let environment = runtime?.environment {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if producesStyle {
					FlowSectionHeader("What it produces")
					producesRows(environment)
				} else {
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
						.buttonStyle(.maskinPressed)
						.accessibilityHint("Opens it full screen")
					}
				}
			}
			.sheet(item: $presented) { output in
				OutcomePresenter(environment: environment, output: output, sourceName: sourceName)
			}
		}
	}

	/// The latest page rendered in place, then the rest as rows of one card.
	@ViewBuilder
	private func producesRows(_ environment: AppEnvironment) -> some View {
		let shown = Array(outputs.prefix(6))
		let feature = shown.first.flatMap { $0.isHTML ? $0 : nil }
		let rows = feature == nil ? shown : Array(shown.dropFirst())
		if let feature {
			Button { presented = feature } label: {
				OutcomeFeatureCard(
					environment: environment, output: feature, height: sizeClass == .regular ? 340 : 220)
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityHint("Opens it full screen")
		}
		if !rows.isEmpty {
			VStack(spacing: 0) {
				ForEach(Array(rows.enumerated()), id: \.element.id) { index, output in
					Button { presented = output } label: { OutcomeRow(output: output, grouped: true) }
						.buttonStyle(.maskinPressed)
						.accessibilityHint("Opens it full screen")
					if index < rows.count - 1 { Divider().overlay(MaskinSurface.separator) }
				}
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
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
		if let runtime, let stories = runtime.storiesStore() {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				FlowSectionHeader("Briefings") {
					Text("published when something lands")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
				if stories.cards(forLoop: loopID).isEmpty {
					if stories.hasLoaded {
						Text("No briefings yet. The flow publishes one when a cycle closes or a result lands.")
							.maskinText(.body).foregroundStyle(MaskinColor.ink4)
							.lineSpacing(MaskinSpace.s1)
							.loopNote()
					}
				} else {
					StoryRow(stories: stories, loopID: loopID) { card in openStory = card }
				}
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
				FlowSectionHeader("From the agents") {
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
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				if posts.count > 3 {
					Button(showAll ? "Show fewer" : "Show all \(posts.count)") { showAll.toggle() }
						.buttonStyle(.maskinPressed)
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
					Text("Asks you").maskinText(.caption).foregroundStyle(MaskinColor.sigInk)
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
			.buttonStyle(.maskinPressed)
			.accessibilityHint("Opens the flow's timeline")
			HStack(spacing: MaskinSpace.s6) {
				Button {
					runtime?.buildInChat("About \(name)'s update on this flow: ")
				} label: {
					Label("Discuss", systemImage: "bubble.left")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink3)
				}
				.buttonStyle(.maskinPressed)
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
				FlowSectionHeader("The flow, right now") {
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
		return Button { store.selectedStatus = phase.status } label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(MaskinStatus.label(for: phase.status)).maskinText(.subhead)
				Text("\(phase.count)").maskinText(.mono)
			}
			.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s6)
			.padding(.vertical, MaskinSpace.s4)
			.frame(maxWidth: .infinity)
			.background(selected ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
		}
		.buttonStyle(.maskinPressed)
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
				.buttonStyle(.maskinPressed)
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
						.buttonStyle(.maskinPressed)
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

/// What the flow wants from you and what it is doing: decisions waiting and the objects in
/// motion, from the flow's own posts and members. When it runs next is under the hood.
struct LoopActionsSection: View {
	let store: LoopDetailStore
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s10) {
			needsYou
			inMotion
		}
	}

	private var decisions: [LoopPost] { store.posts.filter(\.isDecision) }

	private var needsYou: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			FlowSectionHeader("Needs you")
			if decisions.isEmpty {
				Text("Nothing needs you on this flow right now.")
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				ForEach(decisions) { post in
					Button { runtime?.openObject(store.loop.id) } label: {
						VStack(alignment: .leading, spacing: MaskinSpace.s3) {
							HStack(alignment: .firstTextBaseline) {
								MonoLabel("Decision", color: MaskinColor.sigInk)
								Spacer(minLength: MaskinSpace.s3)
								RelativeTime(post.date, style: .compact)
									.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
							}
							Text(post.text)
								.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.w650, relativeTo: .body))
								.tracking(-0.012 * MaskinFontSize.t16)
								.foregroundStyle(MaskinColor.ink)
								.lineLimit(5)
								.multilineTextAlignment(.leading)
								.frame(maxWidth: .infinity, alignment: .leading)
							Text("Decide ›")
								.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650, relativeTo: .subheadline))
								.foregroundStyle(MaskinColor.ink)
								.frame(maxWidth: .infinity, alignment: .trailing)
								.padding(.top, MaskinSpace.s3)
						}
						.loopCard()
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
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
			FlowSectionHeader("In motion") {
				Text("\(movingMembers.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			if movingMembers.isEmpty {
				Text("Nothing is in flight.")
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.loopNote()
			} else {
				VStack(spacing: 0) {
					let shown = Array(movingMembers.prefix(8))
					ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
						Button { runtime?.openObject(member.id) } label: {
							HStack(spacing: MaskinSpace.s6) {
								RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
									.fill(MaskinColor.ink5)
									.frame(width: MaskinSpace.s3 + MaskinSpace.s1, height: MaskinSpace.s3 + MaskinSpace.s1)
									.accessibilityHidden(true)
								Text(member.title)
									.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
									.foregroundStyle(MaskinColor.ink)
									.lineLimit(2)
									.multilineTextAlignment(.leading)
								Spacer(minLength: MaskinSpace.s3)
								Text(MaskinStatus.label(for: member.status).uppercased())
									.maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
							}
							.padding(.vertical, MaskinSpace.s7)
							.contentShape(Rectangle())
						}
						.buttonStyle(.maskinPressed)
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
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}
}
