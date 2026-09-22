import { describe, expect, it, vi } from "vitest";
import { createRecordingAutomation, type RecordingAutomationDriver } from "./recordingAutomation";

function setup(onActiveChange?: (active: boolean) => void) {
	const driver: RecordingAutomationDriver = {
		isBusy: () => false,
		listSources: async () => [
			{
				id: "screen:1:0",
				name: "Test screen",
				display_id: "1",
				thumbnail: null,
				appIcon: null,
			},
		],
		settings: () => ({ microphone: false, systemAudio: true, webcam: false }),
		approve: vi.fn().mockResolvedValue(true),
		selectSource: vi.fn().mockResolvedValue(undefined),
		start: vi.fn(async () => {
			await automation.report({ phase: "recording" });
		}),
		stop: vi.fn(),
		cancelStart: vi.fn(),
		report: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn(),
	};
	const automation = createRecordingAutomation(() => driver, onActiveChange);
	return { driver, automation };
}

const start = {
	id: "command-1",
	command: {
		method: "start_recording",
		params: { requestId: "recording-1", sourceId: "screen:1:0" },
	},
} as const;

describe("renderer recording automation", () => {
	it("approves the actual source and settings, starts once, and stops through the shared controls", async () => {
		const { driver, automation } = setup();
		await automation.handle(start);
		expect(driver.approve).toHaveBeenCalledWith("command-1", {
			sourceName: "Test screen",
			microphone: false,
			systemAudio: true,
			webcam: false,
		});
		expect(driver.start).toHaveBeenCalledTimes(1);
		await automation.handle(start);
		expect(driver.start).toHaveBeenCalledTimes(1);
		await automation.handle({
			id: "stop-1",
			command: { method: "stop_recording", params: { recordingId: "wrong-id" } },
		});
		expect(driver.stop).not.toHaveBeenCalled();
		await automation.handle({
			id: "stop-2",
			command: { method: "stop_recording", params: { recordingId: "recording-1" } },
		});
		expect(driver.stop).toHaveBeenCalledTimes(1);
		await automation.report({ phase: "recording", paused: false });
		await automation.handle({
			id: "stop-3",
			command: { method: "stop_recording", params: { recordingId: "recording-1" } },
		});
		expect(driver.stop).toHaveBeenCalledTimes(1);
		expect(driver.report).toHaveBeenCalledWith({
			recordingId: "recording-1",
			phase: "finalizing",
		});
		automation.warn("Webcam capture was unavailable.");
		await automation.report({ phase: "completed", videoPath: "/tmp/test.webm" });
		expect(driver.report).toHaveBeenLastCalledWith({
			recordingId: "recording-1",
			phase: "completed",
			videoPath: "/tmp/test.webm",
			warnings: ["Webcam capture was unavailable."],
		});
		expect(automation.isActive()).toBe(false);
	});

	it("does not start after an approval times out or the user refuses", async () => {
		const { driver, automation } = setup();
		let approve!: (value: boolean) => void;
		driver.approve = () =>
			new Promise((resolve) => {
				approve = resolve;
			});
		const pending = automation.handle(start);
		await Promise.resolve();
		automation.cancel(start.id);
		approve(true);
		await pending;
		expect(driver.start).not.toHaveBeenCalled();
		expect(driver.cancelStart).toHaveBeenCalledOnce();
		expect(driver.reply).toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.stringContaining("cancelled") }),
		);
		driver.approve = async () => false;
		await automation.handle(start);
		expect(driver.start).not.toHaveBeenCalled();
	});

	it("rejects disappeared sources, manual recordings, and settings changed during consent", async () => {
		const { driver, automation } = setup();
		await automation.handle({
			...start,
			command: {
				...start.command,
				params: { ...start.command.params, sourceId: "screen:missing" },
			},
		});
		expect(driver.approve).not.toHaveBeenCalled();
		driver.isBusy = () => true;
		await automation.handle(start);
		expect(driver.approve).not.toHaveBeenCalled();
		driver.isBusy = () => false;
		driver.approve = async () => {
			driver.settings = () => ({ microphone: true, systemAudio: true, webcam: false });
			return true;
		};
		await automation.handle(start);
		expect(driver.start).not.toHaveBeenCalled();
	});

	it("reports when an agent takes over the recorder and when it lets go", async () => {
		const onActiveChange = vi.fn();
		const { automation } = setup(onActiveChange);

		await automation.handle(start);
		expect(onActiveChange).toHaveBeenLastCalledWith(true);

		await automation.report({ phase: "completed", videoPath: "/tmp/test.webm" });
		expect(onActiveChange).toHaveBeenLastCalledWith(false);
		expect(onActiveChange).toHaveBeenCalledTimes(2);
	});

	it("releases the recorder when an agent recording fails", async () => {
		const onActiveChange = vi.fn();
		const { automation } = setup(onActiveChange);

		await automation.handle(start);
		await automation.report({ phase: "failed", error: "capture stopped" });

		expect(onActiveChange).toHaveBeenLastCalledWith(false);
	});
});
