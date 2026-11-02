import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("ForYouRuntime ownership")
struct ForYouRuntimeTests {
	private func directory() -> URL {
		FileManager.default.temporaryDirectory
			.appendingPathComponent("foryou-runtime-\(UUID().uuidString)", isDirectory: true)
	}

	private func queueWrite(on runtime: ForYouRuntime) throws {
		// Held for an hour so it stays queued instead of going out over the network.
		try runtime.outbox.enqueue(
			kind: "decision.reply", lane: "obj-1", summary: "Reply", payload: "hello", holdFor: 3600)
	}

	@Test("each actor's queue lives in its own file")
	func perActorFile() throws {
		let dir = directory()
		let runtime = ForYouRuntime.make(
			environment: AppEnvironment.preview(), directory: dir, start: false)
		try queueWrite(on: runtime)
		#expect(runtime.outbox.fileURLForTesting == ForYouRuntime.outboxFileURL(actorId: "actor-1", directory: dir))
		#expect(FileManager.default.fileExists(atPath: runtime.outbox.fileURLForTesting.path))
	}

	@Test("deletePersistedOutbox removes the file by path with no runtime involved")
	func deleteByPath() throws {
		let dir = directory()
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let file = ForYouRuntime.outboxFileURL(actorId: "actor-9", directory: dir)
		try Data("{}".utf8).write(to: file)

		ForYouRuntime.deletePersistedOutbox(actorId: "actor-9", directory: dir)

		#expect(!FileManager.default.fileExists(atPath: file.path))
	}

	@Test("stop() keeps the queue on disk and in memory")
	func stopKeepsQueue() throws {
		let runtime = ForYouRuntime.make(
			environment: AppEnvironment.preview(), directory: directory())
		try queueWrite(on: runtime)
		runtime.stop()
		#expect(runtime.outbox.entries.count == 1)
		#expect(FileManager.default.fileExists(atPath: runtime.outbox.fileURLForTesting.path))
		runtime.outbox.discardAll()
	}
}
