import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	dialog: vi.fn(),
}));
vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		ipcMain: Object.assign(new EventEmitter(), {
			handle: (name: string, callback: (...args: unknown[]) => unknown) =>
				mocks.handlers.set(name, callback),
			removeHandler: (name: string) => mocks.handlers.delete(name),
		}),
		dialog: { showMessageBox: mocks.dialog },
	};
});

import { ipcMain } from "electron";
import { automationApprovalIsPreauthorized, createAutomationBridge } from "./bridge";

type SenderStub = EventEmitter & { id: number; send: ReturnType<typeof vi.fn> };

const closes: Array<() => void> = [];
afterEach(() => {
	closes.splice(0).forEach((close) => close());
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

function setup() {
	const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, send: vi.fn() });
	const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
	const event = { sender, senderFrame: sender.mainFrame };
	const onClosed = vi.fn();
	const onUpdate = vi.fn();
	const bridge = createAutomationBridge({
		getWindow: () => window,
		ensureWindow: () => {},
		onClosed,
		onUpdate,
	});
	closes.push(bridge.close);
	return { bridge, sender, event, onClosed, onUpdate };
}

describe("automation IPC bridge", () => {
	it("accepts replies and updates only from the current HUD main frame", async () => {
		const { bridge, sender, event, onUpdate } = setup();
		ipcMain.emit("automation:ready", event);
		const pending = bridge.execute({ method: "list_sources", params: {} });
		const message = sender.send.mock.calls[0][1];
		ipcMain.emit(
			"automation:result",
			{ ...event, senderFrame: {} },
			{ id: message.id, result: "untrusted" },
		);
		ipcMain.emit("automation:result", event, { id: message.id, result: { sources: [] } });
		expect(await pending).toEqual({ sources: [] });
		const update = { recordingId: "recording-1", phase: "recording" };
		mocks.handlers.get("automation:update")?.({ ...event, senderFrame: {} }, update);
		expect(onUpdate).not.toHaveBeenCalled();
		mocks.handlers.get("automation:update")?.(event, update);
		expect(onUpdate).toHaveBeenCalledWith(update);
	});

	it("invalidates timed-out approvals and sends a cancellation to the renderer", async () => {
		vi.useFakeTimers();
		const { bridge, sender, event } = setup();
		ipcMain.emit("automation:ready", event);
		const pending = bridge.execute({
			method: "start_recording",
			params: { requestId: "recording-1", sourceId: "screen:1:0" },
		});
		const rejected = expect(pending).rejects.toThrow("timed out");
		const message = sender.send.mock.calls[0][1];
		let resolveApproval!: (result: { response: number }) => void;
		mocks.dialog.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveApproval = resolve;
				}),
		);
		const approval = mocks.handlers.get("automation:approve")?.(event, message.id, {
			sourceName: "Screen",
			microphone: false,
			systemAudio: false,
			webcam: false,
		});
		await vi.advanceTimersByTimeAsync(180_000);
		await rejected;
		expect(sender.send).toHaveBeenCalledWith("automation:cancel", message.id);
		resolveApproval({ response: 1 });
		expect(await approval).toBe(false);
	});

	it("rejects waiting commands on renderer loss and shutdown", async () => {
		const { bridge, sender } = setup();
		const loading = bridge.execute({ method: "list_sources", params: {} });
		const rejected = expect(loading).rejects.toThrow("closed or reloaded");
		sender.emit("render-process-gone");
		await rejected;
		const waiting = bridge.execute({ method: "list_sources", params: {} });
		const closed = expect(waiting).rejects.toThrow("shutting down");
		bridge.close();
		await closed;
	});

	it("waits for the first load of a newly created recording window", async () => {
		const { bridge, sender, event } = setup();
		const loading = bridge.execute({ method: "list_sources", params: {} });
		sender.emit("did-start-loading");
		ipcMain.emit("automation:ready", event);
		await Promise.resolve();
		const message = sender.send.mock.calls[0][1];
		ipcMain.emit("automation:result", event, { id: message.id, result: { sources: [] } });
		expect(await loading).toEqual({ sources: [] });
	});

	async function requestApproval(event: unknown, id: string) {
		return await mocks.handlers.get("automation:approve")?.(event, id, {
			sourceName: "Screen",
			microphone: false,
			systemAudio: false,
			webcam: false,
		});
	}

	function startPending(bridge: ReturnType<typeof createAutomationBridge>, sender: SenderStub) {
		const started = bridge.execute({
			method: "start_recording",
			params: {
				requestId: `recording-${sender.send.mock.calls.length}`,
				sourceId: "screen:1:0",
			},
		});
		started.catch(() => {});
		return sender.send.mock.calls.at(-1)?.[1] as { id: string };
	}

	it("stops asking for the session once the approval checkbox is used", async () => {
		const { bridge, sender, event } = setup();
		ipcMain.emit("automation:ready", event);
		mocks.dialog.mockResolvedValue({ response: 1, checkboxChecked: true });

		expect(await requestApproval(event, startPending(bridge, sender).id)).toBe(true);
		expect(mocks.dialog).toHaveBeenCalledTimes(1);

		expect(await requestApproval(event, startPending(bridge, sender).id)).toBe(true);
		expect(mocks.dialog).toHaveBeenCalledTimes(1);
	});

	it("keeps asking when the approval checkbox is left alone", async () => {
		const { bridge, sender, event } = setup();
		ipcMain.emit("automation:ready", event);
		mocks.dialog.mockResolvedValue({ response: 1, checkboxChecked: false });

		await requestApproval(event, startPending(bridge, sender).id);
		await requestApproval(event, startPending(bridge, sender).id);

		expect(mocks.dialog).toHaveBeenCalledTimes(2);
	});

	it("never shows the dialog when the launch flag preauthorized automation", async () => {
		vi.stubEnv("RECORDLY_AUTOMATION_AUTO_APPROVE", "1");
		const { bridge, sender, event } = setup();
		ipcMain.emit("automation:ready", event);
		mocks.dialog.mockRejectedValue(new Error("the dialog must not be shown"));

		expect(await requestApproval(event, startPending(bridge, sender).id)).toBe(true);
		expect(mocks.dialog).not.toHaveBeenCalled();
	});

	it("never suppresses the dialog when approval is declined", async () => {
		const { bridge, sender, event } = setup();
		ipcMain.emit("automation:ready", event);
		mocks.dialog.mockResolvedValue({ response: 0, checkboxChecked: true });

		expect(await requestApproval(event, startPending(bridge, sender).id)).toBe(false);
		expect(await requestApproval(event, startPending(bridge, sender).id)).toBe(false);
		expect(mocks.dialog).toHaveBeenCalledTimes(2);
	});
});

describe("automation approval preauthorization", () => {
	it("stays off unless it is explicitly requested at launch", () => {
		expect(automationApprovalIsPreauthorized({}, [])).toBe(false);
		expect(
			automationApprovalIsPreauthorized({ RECORDLY_AUTOMATION_AUTO_APPROVE: "0" }, []),
		).toBe(false);
	});

	it("honours the environment variable and the launch flag", () => {
		expect(
			automationApprovalIsPreauthorized({ RECORDLY_AUTOMATION_AUTO_APPROVE: "1" }, []),
		).toBe(true);
		expect(automationApprovalIsPreauthorized({}, ["--automation-auto-approve"])).toBe(true);
	});
});
