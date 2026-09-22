import { randomUUID } from "node:crypto";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import type { AutomationCommand, RecordingUpdate, RendererAutomationResult } from "./protocol";
import { AutomationError, isRecord } from "./protocol";

export function createAutomationBridge(options: {
	getWindow: () => BrowserWindow | null;
	ensureWindow: () => void;
	onUpdate: (update: RecordingUpdate) => void;
	onClosed: () => void;
}) {
	const pending = new Map<
		string,
		{
			window: BrowserWindow;
			method: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const ready = new Set<number>();
	const observed = new Set<number>();
	const waiters = new Set<{
		windowId: number;
		resolve: () => void;
		reject: (error: Error) => void;
	}>();
	let recordingWindowId: number | undefined;
	const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
		const window = options.getWindow();
		return (
			window &&
			event.sender === window.webContents &&
			event.senderFrame === window.webContents.mainFrame
		);
	};

	const observeWindow = (window: BrowserWindow) => {
		const senderId = window.webContents.id;
		if (observed.has(senderId)) return;
		observed.add(senderId);
		const unavailable = () => {
			ready.delete(senderId);
			for (const waiter of waiters) {
				if (waiter.windowId === senderId)
					waiter.reject(new Error("The recording window closed or reloaded."));
			}
			for (const [id, request] of pending) {
				if (request.window.isDestroyed() || request.window.webContents.id === senderId) {
					clearTimeout(request.timer);
					request.reject(new Error("The recording window closed."));
					pending.delete(id);
				}
			}
			if (recordingWindowId === senderId) options.onClosed();
		};
		window.webContents.once("destroyed", () => {
			observed.delete(senderId);
			unavailable();
		});
		window.webContents.on("render-process-gone", unavailable);
		window.webContents.on("did-start-loading", () => {
			if (ready.has(senderId)) unavailable();
		});
	};
	const onReady = (event: Electron.IpcMainEvent) => {
		if (!trusted(event) || ready.has(event.sender.id)) return;
		const window = options.getWindow();
		if (!window) return;
		observeWindow(window);
		ready.add(event.sender.id);
		for (const waiter of waiters) {
			if (waiter.windowId === event.sender.id) waiter.resolve();
		}
	};
	const onResult = (event: Electron.IpcMainEvent, result: RendererAutomationResult) => {
		if (!trusted(event) || !isRecord(result) || typeof result.id !== "string") return;
		const request = pending.get(result.id);
		if (!request || request.window.webContents !== event.sender) return;
		clearTimeout(request.timer);
		pending.delete(result.id);
		if (typeof result.error === "string") request.reject(new Error(result.error));
		else request.resolve(result.result);
	};
	ipcMain.on("automation:ready", onReady);
	ipcMain.on("automation:result", onResult);
	ipcMain.handle("automation:update", (event, update: RecordingUpdate) => {
		if (
			!trusted(event) ||
			!isRecord(update) ||
			typeof update.recordingId !== "string" ||
			!["starting", "recording", "finalizing", "completed", "cancelled", "failed"].includes(
				update.phase,
			)
		)
			return;
		options.onUpdate(update);
	});
	ipcMain.handle("automation:approve", async (event, id: unknown, details: unknown) => {
		if (!trusted(event) || typeof id !== "string" || !isRecord(details)) return false;
		const request = pending.get(id);
		if (
			!request ||
			request.method !== "start_recording" ||
			request.window.webContents !== event.sender
		)
			return false;
		if (
			typeof details.sourceName !== "string" ||
			details.sourceName.length > 512 ||
			[details.microphone, details.systemAudio, details.webcam].some(
				(value) => typeof value !== "boolean",
			)
		)
			return false;
		const result = await dialog.showMessageBox(request.window, {
			type: "question",
			title: "Allow agent recording?",
			message: `An AI agent wants Recordly to record ${details.sourceName}.`,
			detail: `Microphone: ${details.microphone ? "on" : "off"}\nSystem audio: ${details.systemAudio ? "on" : "off"}\nWebcam: ${details.webcam ? "on" : "off"}\n\nYou can stop the recording using Recordly's controls.`,
			buttons: ["Cancel", "Start recording"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
		});
		return result.response === 1 && pending.has(id);
	});

	return {
		async execute(command: Exclude<AutomationCommand, { method: "get_recording_status" }>) {
			if (pending.size + waiters.size >= 16)
				throw new AutomationError("BUSY", "Too many pending recording commands.", 429);
			options.ensureWindow();
			const window = options.getWindow();
			if (!window || window.isDestroyed())
				throw new Error("The recording window is unavailable.");
			observeWindow(window);
			if (!ready.has(window.webContents.id)) {
				await new Promise<void>((resolve, reject) => {
					const waiter = {
						windowId: window.webContents.id,
						resolve: () => {
							clearTimeout(timer);
							waiters.delete(waiter);
							resolve();
						},
						reject: (error: Error) => {
							clearTimeout(timer);
							waiters.delete(waiter);
							reject(error);
						},
					};
					const timer = setTimeout(() => {
						waiter.reject(new Error("The recording window did not become ready."));
					}, 15_000);
					waiters.add(waiter);
				});
			}
			if (window.isDestroyed()) throw new Error("The recording window closed.");
			if (command.method === "start_recording") recordingWindowId = window.webContents.id;
			return new Promise<unknown>((resolve, reject) => {
				const id = randomUUID();
				const timer = setTimeout(
					() => {
						pending.delete(id);
						if (!window.isDestroyed()) window.webContents.send("automation:cancel", id);
						reject(
							new Error(
								"Recording command timed out. Check Recordly before retrying.",
							),
						);
					},
					command.method === "start_recording" ? 180_000 : 20_000,
				);
				pending.set(id, { window, method: command.method, resolve, reject, timer });
				try {
					window.webContents.send("automation:command", { id, command });
				} catch (error) {
					clearTimeout(timer);
					pending.delete(id);
					reject(error);
				}
			});
		},
		close() {
			ipcMain.removeListener("automation:ready", onReady);
			ipcMain.removeListener("automation:result", onResult);
			ipcMain.removeHandler("automation:update");
			ipcMain.removeHandler("automation:approve");
			for (const waiter of waiters) waiter.reject(new Error("Recordly is shutting down."));
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("Recordly is shutting down."));
			}
			pending.clear();
		},
	};
}
