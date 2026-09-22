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
import { createAutomationBridge } from "./bridge";

const closes: Array<() => void> = [];
afterEach(() => {
	closes.splice(0).forEach((close) => close());
	vi.useRealTimers();
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
});
