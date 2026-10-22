import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The top of an object page (`specs/8-Objects.md` → Object detail → Header): type glyph and
/// name, the full title, one row of property chips that each open a picker, and when it was last
/// touched. Properties live here, next to the title, not in a card further down.
struct ObjectHeaderView: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// False renders the chips as plain faces (snapshots: `Menu` does not draw offscreen).
	var interactiveChips = true

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: MaskinObjectType.glyph(for: object.type))
					.maskinSymbol(MaskinFontSize.t16, weight: .medium)
				Text(store.directory.typeName(object.type))
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
			}
			.foregroundStyle(MaskinColor.ink4)
			.accessibilityElement(children: .combine)

			Text(object.displayTitle)
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.top, MaskinSpace.s4)
				.accessibilityAddTraits(.isHeader)

			if object.status == ObjectDetailStore.archivedStatus {
				archivedBanner.padding(.top, MaskinSpace.s7)
			}

			ObjectHeaderChips(store: store, object: object, interactive: interactiveChips)
				.padding(.top, MaskinSpace.s8)

			if let activity = object.activeActivity, !activity.isEmpty {
				HStack(spacing: MaskinSpace.s3) {
					DetailWorkingBars()
					Text(activity).lineLimit(1)
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.sigInk)
				.padding(.horizontal, MaskinSpace.s7)
				.frame(minHeight: MaskinSpace.s13)
				.background(MaskinColor.sigTint, in: Capsule())
				.padding(.top, MaskinSpace.s5)
				.accessibilityLabel("Working: \(activity)")
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

/// Status · driver · priority · due, each a 32pt chip opening its picker; a `+` chip offers the
/// properties not set yet. Every chip keeps a 44pt hit area around its 32pt face.
struct ObjectHeaderChips: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// False draws every chip's face without its menu (snapshots).
	var interactive = true
	@State private var pickingDue = false

	/// Priority values offered when the workspace hasn't set one yet; a value already stored is
	/// shown as stored, whatever it is.
	static let priorityOptions = ["urgent", "high", "medium", "low"]

	var body: some View {
		ChipFlow(spacing: MaskinSpace.s3) {
			statusChip
			driverChip
			if let priority = store.priority { priorityChip(priority) }
			if let due = store.dueDate { dueChip(due) }
			if store.priority == nil || store.dueDate == nil { addChip }
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
			ForEach(Self.priorityOptions, id: \.self) { option in
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
					ForEach(Self.priorityOptions, id: \.self) { option in
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
