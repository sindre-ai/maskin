import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's question as a decision card in the thread (the web's `QuestionOptions`, in the
/// look of the For You decision card). Each option is a full-width row with the agent's
/// description under it; the one the agent recommends is marked. Single-select questions replace
/// the pick on tap; multi-select toggles. "Send answer" posts one ordinary message once every
/// question has a pick, through the chat outbox, so it works offline. Once answered the card
/// collapses to a read-only summary of what was picked.
struct QuestionOptionsView: View {
	let questions: [ChatQuestionItem]
	/// What a later human message picked, when this question was already answered.
	let answers: [ChatQuestionAnswer.Answer]?
	let onSubmit: ([Int: [String]]) -> Void

	@State private var picked: [Int: [String]]

	init(
		questions: [ChatQuestionItem], answers: [ChatQuestionAnswer.Answer]?,
		picked: [Int: [String]] = [:], onSubmit: @escaping ([Int: [String]]) -> Void
	) {
		self.questions = questions
		self.answers = answers
		self.onSubmit = onSubmit
		_picked = State(initialValue: picked)
	}

	var body: some View {
		if let answers {
			answeredSummary(answers)
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s8) {
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
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: cardShape)
			.overlay(cardShape.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.padding(.top, MaskinSpace.s3)
			.accessibilityElement(children: .contain)
		}
	}

	private var cardShape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
	}

	private var complete: Bool {
		questions.allSatisfy { !(picked[$0.index] ?? []).isEmpty }
	}

	private func group(_ question: ChatQuestionItem) -> some View {
		let chosen = picked[question.index] ?? []
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(question.header.uppercased()).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				Text(question.question).maskinText(.headline).foregroundStyle(MaskinColor.ink)
					.fixedSize(horizontal: false, vertical: true)
			}
			.accessibilityElement(children: .combine)
			.accessibilityAddTraits(.isHeader)
			VStack(spacing: MaskinSpace.s4) {
				ForEach(question.options, id: \.self) { option in
					let isChosen = chosen.contains(option.label)
					Button {
						toggle(question, option.label)
					} label: {
						OptionRowLabel(option: option, chosen: isChosen)
					}
					.buttonStyle(QuestionOptionStyle(chosen: isChosen, recommended: option.recommended))
					.accessibilityLabel(accessibilityLabel(option))
					.accessibilityAddTraits(isChosen ? .isSelected : [])
				}
			}
			if question.multiSelect {
				Text("Pick as many as apply").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private func accessibilityLabel(_ option: ChatQuestionItem.Option) -> String {
		var parts = [option.label]
		if option.recommended { parts.append("recommended") }
		if let detail = option.detail, !detail.isEmpty { parts.append(detail) }
		return parts.joined(separator: ", ")
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

private struct OptionRowLabel: View {
	let option: ChatQuestionItem.Option
	let chosen: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s4) {
				if chosen {
					Image(systemName: "checkmark").font(.system(size: MaskinFontSize.t12, weight: .bold))
				}
				Text(option.label).maskinText(.subhead).fontWeight(.semibold)
					.multilineTextAlignment(.leading)
				Spacer(minLength: MaskinSpace.s3)
				if option.recommended {
					Text("RECOMMENDED").maskinText(.microLabel)
						.foregroundStyle(chosen ? MaskinSurface.onInverse : MaskinColor.sigInk)
						.opacity(chosen ? 0.7 : 1)
				}
			}
			if let detail = option.detail, !detail.isEmpty {
				Text(detail).maskinText(.caption).opacity(0.72).multilineTextAlignment(.leading)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// A picked option is the filled inverse bar; the recommended one is tinted so it reads as the
/// agent's suggestion without looking already chosen; the rest are outlined.
private struct QuestionOptionStyle: ButtonStyle {
	let chosen: Bool
	let recommended: Bool

	func makeBody(configuration: Configuration) -> some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
		configuration.label
			.foregroundStyle(chosen ? MaskinSurface.onInverse : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s6)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(background, in: shape)
			.overlay(shape.strokeBorder(border, lineWidth: 1))
			.scaleEffect(configuration.isPressed ? 0.985 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(shape)
	}

	private var background: Color {
		chosen ? MaskinSurface.inverse : (recommended ? MaskinSurface.fill : MaskinSurface.card)
	}

	private var border: Color {
		chosen ? .clear : (recommended ? MaskinColor.ruleStrong : MaskinSurface.line)
	}
}
