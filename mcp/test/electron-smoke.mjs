import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (process.platform !== "linux")
	throw new Error("This synthetic capture smoke currently runs on Linux.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const directory = await mkdtemp(path.join(os.tmpdir(), "recordly-electron-mcp-"));
const connectionFile = path.join(directory, "automation.json");
const readyFile = path.join(directory, "ready");
const stopFile = path.join(directory, "stop");
const wrapper = path.join(directory, "main.cjs");
const rendererSetup = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  let tick = 0;
  setInterval(() => {
    ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#20dd99'; ctx.fillRect((tick++ * 7) % 540, 100, 100, 100);
    ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif';
    ctx.fillText('Recordly MCP synthetic capture', 35, 55);
  }, 33);
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  return window.electronAPI.setCountdownDelay(0);
})()`;
await writeFile(
	wrapper,
	`
const { app, dialog, desktopCapturer } = require('electron');
const fs = require('node:fs');
app.setName('Recordly MCP smoke');
app.setPath('userData', ${JSON.stringify(directory)});
app.setAppPath(${JSON.stringify(root)});
dialog.showMessageBox = async (_window, options) => {
  if (options?.title !== 'Allow agent recording?') throw new Error('Unexpected dialog');
  return { response: 1, checkboxChecked: false };
};
desktopCapturer.getSources = async () => { throw new Error('Smoke must not enumerate real capture sources'); };
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-finish-load', async () => {
    if (contents.getURL().includes('windowType=editor')) return;
    try {
      await contents.executeJavaScript(${JSON.stringify(rendererSetup)});
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
    } catch (error) { console.error(error); }
  });
});
setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) app.quit(); }, 100).unref();
require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});
`,
);

let logs = "";
const child = spawn(require("electron"), [wrapper, "--ozone-platform=x11"], {
	cwd: root,
	env: {
		...process.env,
		VITE_DEV_SERVER_URL: "",
		RECORDLY_AUTOMATION: "1",
		RECORDLY_AUTOMATION_FILE: connectionFile,
		XDG_SESSION_TYPE: "wayland",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
	logs = (logs + chunk).slice(-12000);
});
child.stderr.on("data", (chunk) => {
	logs = (logs + chunk).slice(-12000);
});
const client = new Client({ name: "recordly-electron-smoke", version: "1.0.0" });

async function waitFor(check, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}\n${logs}`);
		const result = await check();
		if (result) return result;
		await delay(100);
	}
	throw new Error(`Smoke timed out\n${logs}`);
}

try {
	await waitFor(
		async () =>
			(await stat(readyFile).catch(() => null)) &&
			(await stat(connectionFile).catch(() => null)),
	);
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [path.join(root, "mcp/src/cli.mjs"), "--connection", connectionFile],
			stderr: "pipe",
		}),
	);
	const call = async (name, args = {}) => {
		const result = await client.callTool({ name, arguments: args });
		assert.ok(!result.isError, JSON.stringify(result));
		return result.structuredContent;
	};
	const sources = await call("list_sources");
	assert.equal(sources.sources.length, 1);
	assert.equal(sources.sources[0].id, "screen:linux-portal");
	const requestId = "recordly-smoke-123";
	const args = { requestId, sourceId: "screen:linux-portal" };
	assert.equal((await call("start_recording", args)).phase, "starting");
	assert.equal((await call("start_recording", args)).recordingId, requestId);
	await waitFor(async () => {
		const status = await call("get_recording_status");
		assert.notEqual(status.phase, "failed", JSON.stringify(status));
		return status.phase === "recording";
	});
	await delay(1500);
	await call("stop_recording", { recordingId: requestId });
	const completed = await waitFor(async () => {
		const status = await call("get_recording_status", { recordingId: requestId });
		assert.notEqual(status.phase, "failed", JSON.stringify(status));
		return status.phase === "completed" && status;
	});
	assert.ok((await stat(completed.videoPath)).size > 1000);
	const probe = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,width,height",
			"-of",
			"json",
			completed.videoPath,
		],
		{ encoding: "utf8" },
	);
	assert.equal(probe.status, 0, probe.stderr);
	assert.ok(
		JSON.parse(probe.stdout).streams.some(
			(stream) => stream.codec_type === "video" && stream.width === 640,
		),
	);
	assert.equal(
		(await call("stop_recording", { recordingId: requestId })).videoPath,
		completed.videoPath,
	);
	console.log(
		"Electron MCP smoke passed: separate MCP process → local API → HUD → encoded synthetic video → finalized path.",
	);
} catch (error) {
	console.error(logs);
	throw error;
} finally {
	await client.close();
	await writeFile(stopFile, "stop");
	if (child.exitCode === null) await Promise.race([once(child, "exit"), delay(5000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
	await rm(directory, { recursive: true, force: true });
}
