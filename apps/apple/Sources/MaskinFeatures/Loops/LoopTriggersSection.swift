import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One trigger as the flow page's Triggers list shows it: "Name · when", then what happens.
struct LoopTriggerLine: Equatable, Identifiable {
	let id: String
	let name: String
	let when: String
	let then: String?

	init(step: LoopStep) {
		id = step.triggerID
		name = step.displayName
		when = step.firesSummary
		then = Self.thenText(step)
	}

	/// What the trigger does: the first line of its instruction, else who picks it up.
	static func thenText(_ step: LoopStep) -> String? {
		let prompt = step.actionPrompt?
			.split(whereSeparator: \.isNewline)
			.map { $0.trimmingCharacters(in: .whitespaces) }
			.first { !$0.isEmpty }
		if let prompt { return prompt }
		if let agent = step.agentName { return "\(agent) picks it up." }
		return nil
	}
}

/// The flow page's Triggers list (Setup tab).
struct LoopTriggersSection: View {
	let steps: [LoopStep]
	var onOpenTrigger: (String) -> Void = { _ in }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			if !steps.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					FlowSectionHeader("Triggers")
					VStack(spacing: 0) {
						ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
							let line = LoopTriggerLine(step: step)
							Button { onOpenTrigger(step.triggerID) } label: {
								VStack(alignment: .leading, spacing: MaskinSpace.s1) {
									(Text(line.name).foregroundStyle(MaskinColor.ink)
										+ Text(" · \(line.when)").foregroundStyle(MaskinColor.ink4))
										.maskinText(.headline)
									if let then = line.then {
										Text(then).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
											.lineLimit(3)
									}
								}
								.frame(maxWidth: .infinity, alignment: .leading)
								.padding(.vertical, MaskinSpace.s6)
								.contentShape(Rectangle())
							}
							.buttonStyle(.maskinPressed)
							.accessibilityHint("Opens this trigger")
							if index < steps.count - 1 { Divider().overlay(MaskinSurface.separator) }
						}
					}
					.padding(.horizontal, MaskinSpace.s8)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				}
			}
		}
	}
}
