import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The top of an object page (`specs/8-Objects.md` → Object detail → Header), laid out as the web
/// item page is: the title first, then one meta line (star, type, status, owner, priority, due,
/// "Spawned by …"), then at most one thin line when an agent is working or asks a question.
/// Properties live here, next to the title, not in a card further down.
struct ObjectHeaderView: View {
	@Environment(AppRuntime.self) private var appRuntime: AppRuntime?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let store: ObjectDetailStore
	let object: WorkObject
	/// False renders the chips as plain faces (snapshots: `Menu` does not draw offscreen).
	var interactiveChips = true
	/// "Answer" on the question line: takes the reader to the comment bar. Hidden when `nil`.
	var onAnswer: (() -> Void)?
	var sessionActions = ObjectSessionActions.none
	@State private var showsOrigin = false

	/// The open question for the reader, from the same feed that fills "Needs you".
	private var ask: ObjectAsk? {
		guard let feed = appRuntime?.forYou.store,
			let entry = feed.entries.first(where: { $0.id == object.id })
		else { return nil }
		return ObjectAsk(entry, senderName: feed.senderName(of: entry.card))
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text(object.displayTitle)
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityAddTraits(.isHeader)

			if object.status == ObjectDetailStore.archivedStatus {
				archivedBanner.padding(.top, MaskinSpace.s7)
			}

			ObjectHeaderChips(store: store, object: object, interactive: interactiveChips) {
				starButton
				typeLabel
			} trailing: {
				if let origin = store.origin { originButton(origin) }
			}
			.padding(.top, MaskinSpace.s4)

			if showsOrigin, let origin = store.origin {
				ObjectOriginPanel(origin: origin, actions: sessionActions)
					.padding(.top, MaskinSpace.s3)
			}

			if object.hasActiveSession {
				workingLine(session: object.lastSession?.isLive == true ? object.lastSession : nil)
					.padding(.top, MaskinSpace.s3)
			} else if ObjectSessionCopy.showsFailed(object.lastSession, hasActiveSession: object.hasActiveSession),
				let session = object.lastSession
			{
				FailedSessionBanner(
					agentName: store.directory.name(for: session.agentID), session: session, actions: sessionActions
				).padding(.top, MaskinSpace.s7)
			}

			if let ask {
				askLine(ask).padding(.top, MaskinSpace.s3)
			}

			if let updated = object.updatedAt {
				HStack(spacing: MaskinSpace.s2) {
					Text("Updated")
					RelativeTime(updated)
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink5)
				.padding(.top, MaskinSpace.s7)
			}
		}
	}

	// MARK: Meta line

	private var starButton: some View {
		Button {
			MaskinHaptics.play(.selection)
			Task { await store.toggleStar() }
		} label: {
			Image(systemName: object.isStarred ? "star.fill" : "star")
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				.foregroundStyle(object.isStarred ? MaskinColor.sig : MaskinColor.ink4)
				.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(object.isStarred ? "Unstar" : "Star")
	}

	private var typeLabel: some View {
		HStack(spacing: MaskinSpace.s3) {
			Image(systemName: MaskinObjectType.glyph(for: object.type))
				.maskinSymbol(MaskinFontSize.t16, weight: .medium)
			Text(store.directory.typeName(object.type))
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
		}
		.foregroundStyle(MaskinColor.ink4)
		.frame(minHeight: MaskinSpace.touchMin)
		.accessibilityElement(children: .combine)
	}

	/// "Spawned by Forge, 2h ago ⌄": opens the chat and session it came from. Nothing without an origin.
	private func originButton(_ origin: ObjectOrigin) -> some View {
		Button {
			withAnimation(reduceMotion ? nil : MaskinMotion.quick) { showsOrigin.toggle() }
		} label: {
			HStack(spacing: 0) {
				Text(ObjectSessionCopy.spawnedBy(agentName: store.directory.name(for: origin.actorId)))
				if let date = origin.spawnedAt {
					Text(", ")
					RelativeTime(date)
				}
				Image(systemName: "chevron.down").maskinSymbol(MaskinFontSize.t12, weight: .bold)
					.rotationEffect(.degrees(showsOrigin ? 180 : 0))
					.padding(.leading, MaskinSpace.s2)
			}
			.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
			.foregroundStyle(MaskinColor.ink4)
			.lineLimit(1)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Show where this came from")
		.accessibilityAddTraits(showsOrigin ? .isSelected : [])
	}

	// MARK: Live lines

	/// One thin line: "Forge is thinking · 12s", Watch and Stop.
	private func workingLine(session: ObjectSession?) -> some View {
		// The session's own agent, which may differ from the item's driver; unknown stays unnamed.
		let name = session.flatMap { store.directory.name(for: $0.agentID) }
		let title = ObjectSessionCopy.thinkingTitle(agentName: name)
		return HStack(spacing: MaskinSpace.s4) {
			DetailWorkingBars()
			Text(title).fontWeight(.semibold).foregroundStyle(MaskinColor.ink2)
				.lineLimit(1)
			if let start = session?.startedAt {
				TimelineView(.periodic(from: .now, by: 1)) { context in
					Text("· \(ObjectSessionCopy.elapsed(since: start, now: context.date) ?? "")")
						.monospacedDigit()
				}
			}
			Spacer(minLength: 0)
			Group {
				if let session, let onWatch = sessionActions.onWatch {
					Button("Watch") { onWatch(session) }.foregroundStyle(MaskinColor.sigInk)
				}
				if let session, let onStop = sessionActions.onStop {
					Button("Stop") { onStop(session) }.foregroundStyle(MaskinColor.ink)
				}
			}
			.fontWeight(.semibold)
			.buttonStyle(.plain)
			.frame(minHeight: MaskinSpace.touchMin)
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
		.foregroundStyle(MaskinColor.ink4)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(title)
	}

	/// One line: "Forge asks: <question>" and Answer; the question takes two lines at most.
	private func askLine(_ ask: ObjectAsk) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			(Text(ObjectSessionCopy.askLead(askedBy: ask.askedBy) + " ").fontWeight(.bold) + Text(ask.text))
				.lineLimit(2)
				.frame(maxWidth: .infinity, alignment: .leading)
			if let onAnswer {
				Button("Answer", action: onAnswer)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.sigInk)
					.buttonStyle(.plain)
					.frame(minHeight: MaskinSpace.touchMin)
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
		.foregroundStyle(MaskinColor.sigInk)
		.accessibilityElement(children: .combine)
	}

	private var archivedBanner: some View {
		HStack(spacing: MaskinSpace.s5) {
			Text("Archived · still searchable")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				.frame(maxWidth: .infinity, alignment: .leading)
			Menu {
				ForEach(store.statusOptions.filter { $0 != ObjectDetailStore.archivedStatus }, id: \.self) { status in
					Button(MaskinStatus.sentenceLabel(for: status)) {
						MaskinHaptics.play(.selection)
						Task { await store.setStatus(status) }
					}
				}
			} label: {
				Text("Unarchive")
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink)
					.padding(.horizontal, MaskinSpace.s5)
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
		}
		.padding(.leading, MaskinSpace.s8)
		.padding(.trailing, MaskinSpace.s3)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
	}
}

/// Priority values offered when the workspace hasn't set one yet; a value already stored is
/// shown as stored, whatever it is. Outside the chips view because a generic type cannot hold it.
enum ObjectHeaderPriority {
	static let options = ["urgent", "high", "medium", "low"]
}

/// Status · driver · priority · due, each a 32pt chip opening its picker; a `+` chip offers the
/// properties not set yet. Every chip keeps a 44pt hit area around its 32pt face.
struct ObjectHeaderChips<Leading: View, Trailing: View>: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// False draws every chip's face without its menu (snapshots).
	var interactive = true
	/// Before the status chip (star, type) and after the last chip (origin), on the same line.
	@ViewBuilder var leading: () -> Leading
	@ViewBuilder var trailing: () -> Trailing
	@State private var pickingDue = false

	var body: some View {
		ChipFlow(spacing: MaskinSpace.s3) {
			leading()
			statusChip
			driverChip
			if let priority = store.priority { priorityChip(priority) }
			if let due = store.dueDate { dueChip(due) }
			if store.priority == nil || store.dueDate == nil { addChip }
			trailing()
		}
		.sheet(isPresented: $pickingDue) {
			DuePickerSheet(date: store.dueDate) { date in Task { await store.setDueDate(date) } }
		}
	}

	/// A chip that opens `menu` when tapped; a plain face when the chips are not interactive.
	@ViewBuilder private func picker<Face: View, Items: View>(
		_ accessibilityLabel: String, @ViewBuilder face: () -> Face, @ViewBuilder menu: () -> Items
	) -> some View {
		if interactive {
			Menu { menu() } label: { face() }.accessibilityLabel(accessibilityLabel)
		} else {
			face().accessibilityLabel(accessibilityLabel)
		}
	}

	// MARK: Status

	private var statusChip: some View {
		let colors = MaskinStatus.colors(for: object.status)
		return picker("Status \(MaskinStatus.label(for: object.status)). Change status") {
			HeaderChip(fill: colors.bg, foreground: colors.fg, label: MaskinStatus.sentenceLabel(for: object.status)) {
				Circle().fill(colors.fg).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			}
			.background {
				StatusBurst(
					trigger: object.status, color: colors.fg, sparks: Self.handsOffStatuses.contains(object.status))
			}
		} menu: {
			ForEach(store.statusOptions, id: \.self) { status in
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setStatus(status) }
				} label: {
					if status == object.status {
						Label(MaskinStatus.sentenceLabel(for: status), systemImage: "checkmark")
					} else {
						Text(MaskinStatus.sentenceLabel(for: status))
					}
				}
			}
		}
	}

	/// Moving an object into one of these means the agents take it from here: a bigger flourish.
	private static var handsOffStatuses: Set<String> { ["active", "in_progress"] }

	// MARK: Driver

	private var driverActors: [ActorRef] {
		// Agents first, then people, each alphabetical.
		store.directory.actors.values.sorted {
			if $0.isAgent != $1.isAgent { return $0.isAgent }
			return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
		}
	}

	private var driverChip: some View {
		let driver = store.directory.actor(for: object.driverId)
		return picker(driver.map { "Owner \($0.name). Change owner" } ?? "No owner. Choose an owner") {
			HeaderChip(foreground: driver == nil ? MaskinColor.ink4 : MaskinColor.ink, label: driver?.name ?? "No owner") {
				if let driver {
					ActorAvatar(name: driver.name, kind: driver.isAgent ? .agent : .human, size: MaskinSpace.s11, seed: driver.id)
				} else {
					Image(systemName: "person").maskinSymbol(MaskinFontSize.t13, weight: .semibold)
				}
			}
		} menu: {
			ForEach(driverActors) { actor in
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setDriver(actor.id) }
				} label: {
					if actor.id == object.driverId {
						Label(actor.name, systemImage: "checkmark")
					} else {
						Label(actor.name, systemImage: actor.isAgent ? "cpu" : "person")
					}
				}
			}
		}
	}

	// MARK: Priority

	private func priorityChip(_ priority: String) -> some View {
		picker("Priority \(priority). Change priority") {
			HeaderChip(label: priority.replacingOccurrences(of: "_", with: " ").capitalized) {
				PriorityBars(level: PriorityBars.level(for: priority))
			}
		} menu: {
			ForEach(ObjectHeaderPriority.options, id: \.self) { option in
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setPriority(option) }
				} label: {
					if option == priority.lowercased() {
						Label(option.capitalized, systemImage: "checkmark")
					} else {
						Text(option.capitalized)
					}
				}
			}
			Divider()
			Button("No priority", role: .destructive) { Task { await store.setPriority(nil) } }
		}
	}

	// MARK: Due

	private func dueChip(_ due: Date) -> some View {
		Button {
			pickingDue = true
		} label: {
			HeaderChip(label: due.formatted(.dateTime.day().month(.abbreviated))) {
				Image(systemName: "calendar").maskinSymbol(MaskinFontSize.t13, weight: .semibold)
			}
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Due \(due.formatted(date: .long, time: .omitted)). Change due date")
	}

	// MARK: Add

	private var addChip: some View {
		picker("Add a property") {
			HeaderChip(foreground: MaskinColor.ink4, label: "Add") {
				Image(systemName: "plus").maskinSymbol(MaskinFontSize.t13, weight: .bold)
			}
		} menu: {
			if store.priority == nil {
				Menu("Set priority") {
					ForEach(ObjectHeaderPriority.options, id: \.self) { option in
						Button(option.capitalized) { Task { await store.setPriority(option) } }
					}
				}
			}
			if store.dueDate == nil {
				Button("Set due date") { pickingDue = true }
			}
		}
	}
}

/// One header chip: a 32pt capsule-ish pill (radius 16) with a leading glyph and a 14 / 600
/// label, inside a 44pt hit area.
struct HeaderChip<Leading: View>: View {
	var fill: Color = MaskinSurface.fill
	var foreground: Color = MaskinColor.ink
	let label: String
	@ViewBuilder var leading: () -> Leading

	init(fill: Color = MaskinSurface.fill, foreground: Color = MaskinColor.ink, label: String, @ViewBuilder leading: @escaping () -> Leading) {
		self.fill = fill
		self.foreground = foreground
		self.label = label
		self.leading = leading
	}

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			leading()
			Text(label)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.lineLimit(1)
		}
		.foregroundStyle(foreground)
		.padding(.horizontal, MaskinSpace.s7)
		.frame(height: MaskinSpace.s14)
		.background(fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
	}
}

/// Three rising bars; how many are solid says how urgent.
struct PriorityBars: View {
	let level: Int

	static func level(for priority: String) -> Int {
		switch priority.lowercased() {
		case "urgent", "critical", "p0": 3
		case "high", "p1": 3
		case "medium", "normal", "p2": 2
		case "low", "p3": 1
		default: 2
		}
	}

	var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s1 / 2) {
			ForEach(0..<3, id: \.self) { index in
				RoundedRectangle(cornerRadius: MaskinRadius.tag / 2, style: .continuous)
					.fill(.primary)
					.frame(width: MaskinSpace.s1 + MaskinSpace.s1 / 4, height: MaskinSpace.s2 + CGFloat(index) * MaskinSpace.s3 / 2)
					.opacity(index < level ? 1 : 0.3)
			}
		}
		.frame(height: MaskinSpace.s6)
		.accessibilityHidden(true)
	}
}

/// Three small bars pulsing while an agent works, the Patina signal for "running".
struct DetailWorkingBars: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var phase = false

	var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s1 / 2) {
			ForEach(0..<3, id: \.self) { index in
				RoundedRectangle(cornerRadius: MaskinRadius.tag / 2, style: .continuous)
					.fill(MaskinColor.sig)
					.frame(width: MaskinSpace.s1 + MaskinSpace.s1 / 4, height: barHeight(index))
			}
		}
		.frame(height: MaskinSpace.s6)
		.onAppear {
			guard !reduceMotion else { return }
			withAnimation(.easeInOut(duration: MaskinDuration.slide * 2).repeatForever(autoreverses: true)) { phase = true }
		}
		.accessibilityHidden(true)
	}

	private func barHeight(_ index: Int) -> CGFloat {
		let low = MaskinSpace.s2
		let high = MaskinSpace.s6
		let rising = (index % 2 == 0) == phase
		return rising ? high : low
	}
}

/// Pick or clear the due date.
struct DuePickerSheet: View {
	let date: Date?
	let save: (Date?) -> Void
	@Environment(\.dismiss) private var dismiss
	@State private var picked: Date

	init(date: Date?, save: @escaping (Date?) -> Void) {
		self.date = date
		self.save = save
		_picked = State(initialValue: date ?? Date())
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: MaskinSpace.s7) {
				DatePicker("Due", selection: $picked, displayedComponents: .date)
					#if os(iOS)
					.datePickerStyle(.graphical)
					#endif
					.padding(.horizontal, MaskinSpace.s7)
				if date != nil {
					Button("Clear due date", role: .destructive) {
						save(nil)
						dismiss()
					}
					.frame(minHeight: MaskinSpace.touchMin)
				}
				Spacer(minLength: 0)
			}
			.padding(.top, MaskinSpace.s5)
			.navigationTitle("Due date")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						save(picked)
						dismiss()
					}
				}
			}
		}
		.presentationDetents([.medium, .large])
	}
}

/// A small flourish when an object's status changes: a ring swells off the chip and fades. When
/// the new status hands the work to the agents it also throws a few sparks. Still under Reduce Motion.
struct StatusBurst: View {
	let trigger: String
	let color: Color
	let sparks: Bool
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	/// 0 = just fired, 1 = finished (invisible). Rests at 1 so nothing shows on first appearance.
	@State private var progress: CGFloat = 1

	private let sparkCount = 8

	var body: some View {
		ZStack {
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(color.opacity(0.5 * (1 - progress)), lineWidth: MaskinSpace.s1)
				.scaleEffect(1 + 0.35 * progress)
			if sparks {
				ForEach(0..<sparkCount, id: \.self) { i in
					let angle = Double(i) / Double(sparkCount) * 2 * .pi
					Circle()
						.fill(color)
						.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
						.offset(x: cos(angle) * MaskinSpace.s14 * progress, y: sin(angle) * MaskinSpace.s11 * progress)
						.opacity(1 - progress)
				}
			}
		}
		.allowsHitTesting(false)
		.accessibilityHidden(true)
		.onChange(of: trigger) { _, _ in
			MaskinHaptics.play(sparks ? .success : .light)
			guard !reduceMotion else { return }
			progress = 0
			Task { @MainActor in
				try? await Task.sleep(for: .milliseconds(30))
				withAnimation(reduceMotion ? nil : .easeOut(duration: MaskinDuration.slide * 3)) { progress = 1 }
			}
		}
	}
}
