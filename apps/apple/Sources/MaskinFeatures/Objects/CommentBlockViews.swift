import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Tasks · 2 of 3": the tasks an agent listed in a comment, each with its checkbox state and a
/// tap through to the task (handoff 1j).
struct CommentTaskList: View {
	let tasks: [(id: String, state: ObjectDetailStore.TaskState?)]
	var open: ((String) -> Void)?

	private var doneCount: Int { tasks.filter { $0.state?.isDone == true }.count }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			MonoLabel("Tasks · \(doneCount) of \(tasks.count)", color: MaskinColor.ink4)
				.padding(.bottom, MaskinSpace.s3)
			ForEach(Array(tasks.enumerated()), id: \.element.id) { _, task in
				Button { open?(task.id) } label: {
					HStack(spacing: MaskinSpace.s5) {
						Image(systemName: task.state?.isDone == true ? "checkmark.square.fill" : "square")
							.maskinSymbol(MaskinFontSize.t20, weight: .regular)
							.foregroundStyle(task.state?.isDone == true ? MaskinColor.ok : MaskinColor.ink5)
						Text(task.state?.title ?? "Task unavailable")
							.maskinText(.subhead)
							.foregroundStyle(task.state?.isDone == true ? MaskinColor.ink4 : MaskinColor.ink)
							.strikethrough(task.state?.isDone == true)
							.frame(maxWidth: .infinity, alignment: .leading)
					}
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.disabled(open == nil || task.state == nil)
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// "Decision · Which plan goes on the page?" with the options as buttons. Taking one posts its
/// label as a reply under the comment; once someone has, the card shows what was chosen.
struct CommentDecisionCard: View {
	let decision: CommentDecision
	var answer: String?
	var onAnswer: (String) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			MonoLabel("Decision", color: MaskinColor.sigInk)
			if !decision.title.isEmpty {
				Text(decision.title).maskinText(.headline).foregroundStyle(MaskinColor.ink)
			}
			if !decision.summary.isEmpty {
				Text(decision.summary).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
			}
			if let answer {
				Label("Answered: \(answer)", systemImage: "checkmark.circle.fill")
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.sigInk)
			} else {
				ViewThatFits(in: .horizontal) {
					HStack(spacing: MaskinSpace.s3) { optionButtons }
					VStack(spacing: MaskinSpace.s3) { optionButtons }
				}
				if let line = decision.silenceLine {
					Text(line).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	@ViewBuilder private var optionButtons: some View {
		ForEach(decision.options) { option in
			Button { onAnswer(option.label) } label: {
				Text(option.label)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(option.recommended ? MaskinSurface.onInverse : MaskinColor.ink)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
					.background(option.recommended ? MaskinSurface.inverse : MaskinSurface.fill, in: Capsule())
			}
			.buttonStyle(.maskinPressed)
		}
	}
}
