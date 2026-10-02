import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's question as tappable choices under its message (the web's `QuestionOptions`).
/// Single-select questions replace the pick on tap; multi-select toggles. "Send answer" posts one
/// ordinary message once every question has a pick, through the outbox, so it works offline.
/// Once answered the chips collapse to a read-only summary of what was picked.
struct QuestionOptionsView: View {
	let questions: [ChatQuestionItem]
	/// What a later human message picked, when this question was already answered.
	let answers: [ChatQuestionAnswer.Answer]?
	let onSubmit: ([Int: [String]]) -> Void

	@State private var picked: [Int: [String]] = [:]

	var body: some View {
		if let answers {
			answeredSummary(answers)
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s7) {
				ForEach(questions) { question in
					group(question)
				}
				HStack(spacing: MaskinSpace.s5) {
					Button {
						MaskinHaptics.play(.light)
						onSubmit(picked)
					} label: {
						Text("Send answer")
							.maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinSurface.onInverse)
							.padding(.horizontal, MaskinSpace.s9)
							.frame(minHeight: MaskinSpace.touchMin)
							.background(MaskinSurface.inverse, in: Capsule())
							.opacity(complete ? 1 : 0.35)
					}
					.buttonStyle(.plain)
					.disabled(!complete)
					Text("or just type your reply").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			.padding(.top, MaskinSpace.s3)
		}
	}

	private var complete: Bool {
		questions.allSatisfy { !(picked[$0.index] ?? []).isEmpty }
	}

	private func group(_ question: ChatQuestionItem) -> some View {
		let chosen = picked[question.index] ?? []
		return VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(question.header).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
			Text(question.question).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
			ChipFlow(spacing: MaskinSpace.s3) {
				ForEach(question.options, id: \.self) { option in
					let isChosen = chosen.contains(option.label)
					Button {
						toggle(question, option.label)
					} label: {
						HStack(spacing: MaskinSpace.s2) {
							if isChosen { Image(systemName: "checkmark").font(.system(size: MaskinFontSize.t11, weight: .bold)) }
							Text(option.label).maskinText(.subhead).fontWeight(.semibold).lineLimit(2)
								.multilineTextAlignment(.leading)
						}
						.foregroundStyle(isChosen ? MaskinSurface.onInverse : MaskinColor.ink)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.background(
							isChosen ? MaskinSurface.inverse : MaskinSurface.card,
							in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
						)
						.overlay(
							RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
								.strokeBorder(isChosen ? Color.clear : MaskinSurface.line, lineWidth: 1))
					}
					.buttonStyle(.plain)
					.accessibilityLabel(option.detail.map { "\(option.label). \($0)" } ?? option.label)
					.accessibilityAddTraits(isChosen ? .isSelected : [])
				}
			}
			if question.multiSelect {
				Text("Pick as many as apply").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private func toggle(_ question: ChatQuestionItem, _ label: String) {
		MaskinHaptics.play(.selection)
		var current = picked[question.index] ?? []
		if question.multiSelect {
			if let at = current.firstIndex(of: label) { current.remove(at: at) } else { current.append(label) }
		} else {
			current = [label]
		}
		picked[question.index] = current
	}

	private func answeredSummary(_ answers: [ChatQuestionAnswer.Answer]) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			ForEach(questions) { question in
				let selection = answers.first { $0.header == question.header }?.selected ?? []
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Image(systemName: "checkmark.circle.fill").foregroundStyle(MaskinColor.success)
						.accessibilityHidden(true)
					Text("\(question.header): \(selection.joined(separator: ", "))")
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				}
				.accessibilityElement(children: .combine)
			}
		}
		.padding(.top, MaskinSpace.s2)
	}
}
