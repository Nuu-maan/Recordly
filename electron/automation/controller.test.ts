import { describe, expect, it, vi } from "vitest";
import { RecordingController } from "./controller";
import { parseAutomationCommand } from "./protocol";

const start = {
	method: "start_recording",
	params: { requestId: "recording-123", sourceId: "screen:1:0" },
} as const;

describe("recording automation lifecycle", () => {
	it("starts once, rejects competing recordings, and keeps completed output on stop retries", async () => {
		const execute = vi.fn().mockResolvedValue({});
		const controller = new RecordingController(execute);
		expect(await controller.call(start)).toMatchObject({ phase: "starting" });
		await controller.call(start);
		expect(execute).toHaveBeenCalledTimes(1);
		await expect(controller.call({ ...start, params: { ...start.params, requestId: "another-123" } }))
			.rejects.toMatchObject({ code: "BUSY" });
		await expect(controller.call({ ...start, params: { ...start.params, sourceId: "screen:2:0" } }))
			.rejects.toMatchObject({ code: "ID_CONFLICT" });
		const stop = { method: "stop_recording", params: { recordingId: start.params.requestId } } as const;
		await expect(controller.call(stop)).rejects.toMatchObject({ code: "NOT_READY" });
		controller.update({ recordingId: start.params.requestId, phase: "recording" });
		expect(await controller.call(stop)).toMatchObject({ phase: "finalizing" });
		await controller.call(stop);
		expect(execute).toHaveBeenCalledTimes(2);
		controller.update({ recordingId: start.params.requestId, phase: "recording" });
		controller.update({ recordingId: start.params.requestId, phase: "completed", videoPath: "/videos/demo.webm" });
		controller.rendererClosed();
		expect(await controller.call(stop)).toMatchObject({ phase: "completed", videoPath: "/videos/demo.webm" });
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("reports renderer failures and allows a new recording", async () => {
		const controller = new RecordingController(async () => { throw new Error("Permission denied"); });
		await controller.call(start);
		await Promise.resolve();
		expect(await controller.call({ method: "get_recording_status", params: {} }))
			.toMatchObject({ phase: "failed", error: "Error: Permission denied" });
		await expect(controller.call({ method: "stop_recording", params: { recordingId: "unknown-123" } }))
			.rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects malformed commands before dispatch", () => {
		for (const value of [null, [], { method: "__proto__", params: {} },
			{ ...start, params: { ...start.params, outputPath: "/etc/passwd" } },
			{ ...start, params: { ...start.params, sourceId: "file:///secret" } },
			{ method: "stop_recording", params: {} }]) {
			expect(() => parseAutomationCommand(value)).toThrow();
		}
		expect(parseAutomationCommand(start)).toEqual(start);
	});
});
