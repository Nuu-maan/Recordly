import path from "node:path";
import { app } from "electron";
import { createHudOverlayWindow, getHudOverlayWindow } from "../windows";
import { createAutomationBridge } from "./bridge";
import { RecordingController } from "./controller";
import { startAutomationServer } from "./server";

export async function startRecordingAutomation() {
	if (process.env.RECORDLY_AUTOMATION !== "1" && !process.argv.includes("--enable-automation"))
		return;
	const connectionFile =
		process.argv
			.find((arg) => arg.startsWith("--automation-connection-file="))
			?.split("=")
			.slice(1)
			.join("=") ??
		process.env.RECORDLY_AUTOMATION_FILE ??
		path.join(app.getPath("userData"), "automation.json");
	const controller = new RecordingController((command) => bridge.execute(command));
	const bridge = createAutomationBridge({
		getWindow: getHudOverlayWindow,
		ensureWindow: () => {
			if (!getHudOverlayWindow()) createHudOverlayWindow();
		},
		onUpdate: (update) => controller.update(update),
		onClosed: () => controller.rendererClosed(),
	});
	try {
		const server = await startAutomationServer({
			connectionFile,
			dispatch: (command) => controller.call(command),
		});
		console.info(`Recordly automation connection file: ${connectionFile}`);
		app.once("will-quit", () => {
			server.close();
			bridge.close();
		});
	} catch (error) {
		bridge.close();
		console.error("Recordly automation could not start:", error);
	}
}
