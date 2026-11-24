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
	/// Who answered and when, with the typed words when nothing was picked.
	let note: ChatQuestionState.Note?
	let onSubmit: ([Int: [String]]) -> Void
	/// Closes the card without answering (the X).
	var onDismiss: (() -> Void)?

	/// A question's text (a whole draft, say) shows this many lines; the rest opens with Show all.
	static let detailLines = 6

	@State private var picked: [Int: [String]]

	init(
		questions: [ChatQuestionItem], answers: [ChatQuestionAnswer.Answer]?,
		note: ChatQuestionState.Note? = nil,
		picked: [Int: [String]] = [:], onSubmit: @escaping ([Int: [String]]) -> Void,
		onDismiss: (() -> Void)? = nil
	) {
		self.onDismiss = onDismiss
		self.questions = questions
		self.answers = answers
		self.note = note
		self.onSubmit = onSubmit
		_picked = State(initialValue: picked)
	}

	var body: some View {
		if let answers {
			// Answered by typing or dismissed with no record of who: nothing to summarise.
			if !answers.isEmpty || note != nil { answeredSummary(answers) }
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s8) {
				ForEach(questions) { question in
					group(question)
				}
				actionRow
			}
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: cardShape)
			.overlay(cardShape.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.padding(.top, MaskinSpace.s3)
			.accessibilityElement(children: .contain)
		}
	}

	/// Send answer, the hint, and the X. On one line when they fit; otherwise the hint drops under
	/// the buttons, so nothing is clipped at 375pt or at large Dynamic Type.
	private var actionRow: some View {
		ViewThatFits(in: .horizontal) {
			HStack(spacing: MaskinSpace.s5) {
				sendButton
				hint
				Spacer(minLength: 0)
				dismissButton
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				HStack(spacing: MaskinSpace.s5) {
					sendButton
					Spacer(minLength: 0)
					dismissButton
				}
				hint
			}
		}
	}

	private var sendButton: some View {
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
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!complete)
	}

	private var hint: some View {
		Text("or just type your reply").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			.fixedSize(horizontal: false, vertical: true)
	}

	@ViewBuilder private var dismissButton: some View {
		if let onDismiss {
			Button {
				MaskinHaptics.play(.light)
				onDismiss()
			} label: {
				Image(systemName: "xmark").maskinSymbol(MaskinFontSize.t14, weight: .semibold)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Dismiss question")
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
		let text = QuestionTextSplit(question.question)
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(question.header.uppercased()).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				Text(text.lead).maskinText(.headline).foregroundStyle(MaskinColor.ink)
					.fixedSize(horizontal: false, vertical: true)
			}
			.accessibilityElement(children: .combine)
			.accessibilityAddTraits(.isHeader)
			if let detail = text.detail { CutText(text: detail, lines: Self.detailLines) }
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

	/// One quiet row per answered question: what was asked and what was picked (or typed), then who
	/// answered and when. A question the answer does not cover is left out.
	@ViewBuilder private func answeredSummary(_ answers: [ChatQuestionAnswer.Answer]) -> some View {
		let rows = questions.enumerated().compactMap { offset, question -> (String, String)? in
			let picks = answers.first { $0.header == question.header }?.selected ?? []
			let reply = picks.isEmpty ? (offset == 0 ? note?.text : nil) : picks.joined(separator: ", ")
			guard let reply, !reply.isEmpty else { return nil }
			return (QuestionTextSplit(question.question).lead, reply)
		}
		if !rows.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
						Image(systemName: "checkmark.circle.fill").foregroundStyle(MaskinColor.doneFg)
							.accessibilityHidden(true)
						Text("\(row.0) \(row.1)")
							.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
					}
					.accessibilityElement(children: .combine)
				}
				if let byline { Text(byline).maskinText(.caption).foregroundStyle(MaskinColor.ink4) }
			}
			.padding(.top, MaskinSpace.s2)
		}
	}

	/// "Sam, 08:04": who answered and when, when the row knows.
	private var byline: String? {
		guard let note else { return nil }
		let time = note.date?.formatted(date: .omitted, time: .shortened)
		return [note.actorName, time].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
	}
}

private struct OptionRowLabel: View {
	let option: ChatQuestionItem.Option
	let chosen: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s4) {
				if chosen {
					Image(systemName: "checkmark").maskinSymbol(MaskinFontSize.t12, weight: .bold)
				}
				Text(option.label).maskinText(.subhead).fontWeight(.semibold)
					.multilineTextAlignment(.leading)
				Spacer(minLength: MaskinSpace.s3)
				if option.recommended {
					Text("Suggested").maskinText(.caption).fontWeight(.semibold)
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

/// Running text cut after `lines` lines, faded into the card, with Show all / Show less when there is
/// more. Text that fits shows in full with no button. The full text is measured by a hidden copy, so
/// no character count stands in for the layout.
private struct CutText: View {
	let text: String
	let lines: Int
	@State private var expanded = false
	@State private var fullHeight: CGFloat = 0
	@State private var cutHeight: CGFloat = 0
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// `cutHeight` only follows the text while it is cut, so it keeps the cut height once opened.
	private var isCut: Bool { fullHeight > cutHeight + 1 }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text(text).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				.lineLimit(expanded ? nil : lines)
				.multilineTextAlignment(.leading)
				.frame(maxWidth: .infinity, alignment: .leading)
				.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { if !expanded { cutHeight = $0 } }
				.background(alignment: .top) {
					Text(text).maskinText(.subhead).fixedSize(horizontal: false, vertical: true)
						.frame(maxWidth: .infinity, alignment: .leading)
						.hidden()
						.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fullHeight = $0 }
				}
				.overlay(alignment: .bottom) {
					if isCut && !expanded {
						LinearGradient(
							colors: [MaskinSurface.card.opacity(0), MaskinSurface.card], startPoint: .top, endPoint: .bottom
						)
						.frame(height: MaskinSpace.s11)
						.allowsHitTesting(false)
					}
				}
			if isCut {
				Button {
					MaskinHaptics.play(.light)
					if reduceMotion { expanded.toggle() } else { withAnimation(MaskinMotion.standard) { expanded.toggle() } }
				} label: {
					HStack(spacing: MaskinSpace.s3) {
						Text(expanded ? "Show less" : "Show all")
						Image(systemName: "chevron.down").maskinSymbol(MaskinFontSize.t12, weight: .semibold)
							.rotationEffect(.degrees(expanded ? 180 : 0))
					}
					.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3)
					.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
					.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityValue(expanded ? "Expanded" : "Collapsed")
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Text to review")
	}
}
