import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

private extension View {
	func loopCard() -> some View {
		padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(
				MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}
}

/// What the loop produced: the presentable files first (HTML pages open as a rendered view).
/// Rows are the same ones the Outcomes feed uses.
struct LoopOutputsSection: View {
	let outputs: [LoopOutput]
	let loop: LoopSummary
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	var body: some View {
		if !outputs.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Produced") {
					Text("\(outputs.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
				LazyVGrid(
					columns: [GridItem(.adaptive(minimum: 240), spacing: MaskinSpace.s5)],
					spacing: MaskinSpace.s5
				) {
					ForEach(outputs.prefix(6)) { output in
						Button { runtime?.openFile(output.id) } label: {
							OutcomeRow(outcome: Outcome(output: output, loop: loop))
						}
						.buttonStyle(.plain)
						.accessibilityHint("Opens the file")
					}
				}
			}
		}
	}
}

/// What the agents said on the loop's timeline, newest first.
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
				ForEach(showAll ? posts : Array(posts.prefix(3))) { post in
					Button { runtime?.openObject(loopID) } label: { card(post) }
						.buttonStyle(.plain)
						.accessibilityHint("Opens the loop's timeline")
				}
				if posts.count > 3 {
					Button(showAll ? "Show fewer" : "Show all \(posts.count)") { showAll.toggle() }
						.buttonStyle(.plain)
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private func card(_ post: LoopPost) -> some View {
		let actor = directory.actor(post.actorID)
		return VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s4) {
				ActorAvatar(
					name: actor?.name ?? "Someone", kind: actor?.isAgent == true ? .agent : .human,
					size: MaskinSpace.s11, seed: post.actorID)
				Text(actor?.name ?? "Someone").maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
				Spacer(minLength: MaskinSpace.s3)
				if post.isDecision {
					Text("Asks you").maskinText(.caption).foregroundStyle(MaskinColor.warningStrong)
				}
				RelativeTime(post.date, style: .compact)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
			}
			Text(post.text)
				.maskinText(.body).foregroundStyle(MaskinColor.ink)
				.lineLimit(6)
				.frame(maxWidth: .infinity, alignment: .leading)
			if post.replyCount > 0 {
				Text("\(post.replyCount) \(post.replyCount == 1 ? "reply" : "replies")")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
		.loopCard()
		.contentShape(Rectangle())
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
				SectionHeader("The loop, right now") {
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
