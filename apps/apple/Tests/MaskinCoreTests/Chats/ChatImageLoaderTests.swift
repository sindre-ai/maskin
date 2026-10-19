import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import MaskinCore

/// A real, tiny PNG so the decoder has something to read.
private func png(width: Int = 40, height: Int = 20) -> Data {
	let context = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1))
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	let data = NSMutableData()
	let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
	CGImageDestinationAddImage(destination, context.makeImage()!, nil)
	CGImageDestinationFinalize(destination)
	return data as Data
}

private final class Counter: @unchecked Sendable {
	private let lock = NSLock()
	private var counts: [String: Int] = [:]
	var failing = false
	func hit(_ id: String) -> Int { lock.withLock { counts[id, default: 0] += 1; return counts[id]! } }
	func count(_ id: String) -> Int { lock.withLock { counts[id] ?? 0 } }
}

private final class Concurrency: @unchecked Sendable {
	private let lock = NSLock()
	private var active = 0
	private(set) var peak = 0
	private(set) var started: [String] = []
	func enter(_ id: String) {
		lock.withLock {
			active += 1
			peak = max(peak, active)
			started.append(id)
		}
	}
	func leave() { lock.withLock { active -= 1 } }
	var order: [String] { lock.withLock { started } }
	var highWater: Int { lock.withLock { peak } }
}

/// Holds a fetch until the test opens it.
private actor SlotGate {
	private var isOpen = false
	private var waiting: [CheckedContinuation<Void, Never>] = []
	func wait() async {
		if isOpen { return }
		await withCheckedContinuation { waiting.append($0) }
	}
	func open() {
		isOpen = true
		for continuation in waiting { continuation.resume() }
		waiting = []
	}
}

@Suite("ChatImageLoader") struct ChatImageLoaderTests {
	@Test("no more photos load at once than the cap, and all of them still load")
	func capsConcurrency() async {
		let probe = Concurrency()
		let data = png()
		let loader = ChatImageLoader(maxConcurrent: 3) { id in
			probe.enter(id)
			defer { probe.leave() }
			try? await Task.sleep(for: .milliseconds(30))
			return data
		}
		let ids = (0..<12).map { "f\($0)" }
		let loaded = await withTaskGroup(of: Bool.self) { group in
			for id in ids { group.addTask { await loader.image(for: id) != nil } }
			return await group.reduce(0) { $0 + ($1 ? 1 : 0) }
		}
		#expect(loaded == 12)
		#expect(probe.highWater == 3)
	}

	@Test("while the slots are full, the photo asked for last is loaded first")
	func newestRequestFirst() async {
		let probe = Concurrency()
		let gate = SlotGate()
		let data = png()
		let loader = ChatImageLoader(maxConcurrent: 1) { id in
			probe.enter(id)
			defer { probe.leave() }
			// Hold the only slot until the whole queue is built: no timing decides the order.
			if id == "first" { await gate.wait() }
			return data
		}
		let first = Task { await loader.image(for: "first") }
		#expect(await eventually { () async -> Bool in probe.order == ["first"] })
		var rest: [Task<DecodedImage?, Never>] = []
		for (index, id) in ["a", "b", "c"].enumerated() {
			rest.append(Task { await loader.image(for: id) })
			#expect(await eventually { await loader.queuedCount == index + 1 })
		}
		await gate.open()
		_ = await first.value
		for task in rest { _ = await task.value }
		#expect(probe.order == ["first", "c", "b", "a"])
	}

	@Test("a photo is fetched once and then served from memory")
	func cachesDecodedImages() async {
		let counter = Counter()
		let data = png()
		let loader = ChatImageLoader { id in
			_ = counter.hit(id)
			return data
		}
		let first = await loader.image(for: "f1")
		let second = await loader.image(for: "f1")
		#expect(first?.cgImage.width == 40)
		#expect(second != nil)
		#expect(counter.count("f1") == 1)
		// Once loaded it can be read without waiting, and a file never loaded reads as nil.
		#expect(loader.cachedImage(for: "f1") != nil)
		#expect(loader.cachedImage(for: "never") == nil)
	}

	@Test("rows asking for the same photo at once share one request")
	func dedupesInFlight() async {
		let counter = Counter()
		let data = png()
		let loader = ChatImageLoader { id in
			_ = counter.hit(id)
			try await Task.sleep(for: .milliseconds(50))
			return data
		}
		async let a = loader.image(for: "f1")
		async let b = loader.image(for: "f1")
		async let c = loader.image(for: "f1")
		let results = await [a, b, c]
		#expect(results.allSatisfy { $0 != nil })
		#expect(counter.count("f1") == 1)
	}

	@Test("a failed or undecodable file gives nil and is tried again next time")
	func failuresAreNotRemembered() async {
		let counter = Counter()
		let good = png()
		let loader = ChatImageLoader { id in
			if counter.hit(id) == 1 { throw URLError(.notConnectedToInternet) }
			return good
		}
		#expect(await loader.image(for: "f1") == nil)
		#expect(await loader.image(for: "f1") != nil)
		let junk = ChatImageLoader { _ in Data("not an image".utf8) }
		#expect(await junk.image(for: "x") == nil)
	}

	@Test("the oldest photo is dropped once the cache is full")
	func boundedCache() async {
		let counter = Counter()
		let data = png()
		let loader = ChatImageLoader(capacity: 2) { id in
			_ = counter.hit(id)
			return data
		}
		_ = await loader.image(for: "a")
		_ = await loader.image(for: "b")
		_ = await loader.image(for: "c")
		_ = await loader.image(for: "a")
		#expect(counter.count("a") == 2)
		_ = await loader.image(for: "c")
		#expect(counter.count("c") == 1)
	}
}
