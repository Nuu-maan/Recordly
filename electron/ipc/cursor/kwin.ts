import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CURSOR_SAMPLE_INTERVAL_MS } from "../constants";
import { setLinuxCursorScreenPoint } from "../state";
import { getScreen } from "../utils";

const KWIN_SCRIPT_NAME = "recordly-cursor-bridge";
const MAX_PAYLOAD_BYTES = 128;
const DBUS_TIMEOUT_MS = 4000;

export function isKdeWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	const wayland = env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY);
	const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""} ${env.XDG_SESSION_DESKTOP ?? ""}`;
	return wayland && /kde|plasma/i.test(desktop);
}

type DBusTarget = { objectPath: string; interfaceName: string };

const SCRIPTING: DBusTarget = {
	objectPath: "/Scripting",
	interfaceName: "org.kde.kwin.Scripting",
};

// KWin scripts are only reachable over the session bus and Electron ships no
// D-Bus client. Rather than add a dependency for three calls, shell out to
// whichever standard client the system already has. gdbus comes with glib,
// which Electron already links against; busctl comes with systemd.
const DBUS_CLIENTS: {
	bin: string;
	buildArgs: (target: DBusTarget, method: string, args: string[]) => string[];
}[] = [
	{
		bin: "gdbus",
		buildArgs: (target, method, args) => [
			"call",
			"--session",
			"--dest",
			"org.kde.KWin",
			"--object-path",
			target.objectPath,
			"--method",
			`${target.interfaceName}.${method}`,
			...args,
		],
	},
	{
		bin: "busctl",
		buildArgs: (target, method, args) => [
			"--user",
			"call",
			"org.kde.KWin",
			target.objectPath,
			target.interfaceName,
			method,
			"s".repeat(args.length),
			...args,
		],
	},
];

function callKWin(target: DBusTarget, method: string, args: string[]): string | null {
	for (const client of DBUS_CLIENTS) {
		const result = spawnSync(client.bin, client.buildArgs(target, method, args), {
			encoding: "utf-8",
			timeout: DBUS_TIMEOUT_MS,
		});
		if (result.error || result.status !== 0) {
			continue;
		}
		return (result.stdout ?? "").trim();
	}
	return null;
}

// Reads the pointer from KWin and posts it back over loopback. The timer
// coalesces the signal down to the telemetry sample rate, and only positions
// that actually changed are sent, so an idle pointer costs nothing.
function buildBridgeQml(port: number, token: string): string {
	return `import QtQuick
import org.kde.kwin

Item {
    property int lastX: -1
    property int lastY: -1
    property int pendingX: -1
    property int pendingY: -1

    function post(x, y) {
        var request = new XMLHttpRequest();
        request.open("POST", "http://127.0.0.1:${port}/${token}");
        request.send('{"x":' + x + ',"y":' + y + '}');
    }

    Timer {
        interval: ${CURSOR_SAMPLE_INTERVAL_MS}
        repeat: true
        running: true
        onTriggered: {
            if (pendingX === lastX && pendingY === lastY) {
                return;
            }
            lastX = pendingX;
            lastY = pendingY;
            post(lastX, lastY);
        }
    }

    Component.onCompleted: {
        Workspace.cursorPosChanged.connect(function () {
            pendingX = Workspace.cursorPos.x;
            pendingY = Workspace.cursorPos.y;
        });
    }
}
`;
}

// gdbus answers "(0,)" on some KWin builds and "(int32 0,)" on others, busctl
// answers "i 0". Strip the type keywords so the digits inside them are not
// mistaken for the id. KWin returns -1 when it refused to load the script.
export function parseKWinScriptId(raw: string | null): string | null {
	if (!raw) {
		return null;
	}
	const match = raw.replace(/\b(?:u?int(?:16|32|64)|byte|double)\b/g, " ").match(/-?\d+/);
	if (!match || Number.parseInt(match[0], 10) < 0) {
		return null;
	}
	return match[0];
}

/**
 * Streams the pointer position on KDE Wayland, where uiohook's XRecord hook
 * only ever sees XWayland clients. Returns a stop function, or null when the
 * session is not KDE Wayland. Startup happens in the background so this keeps
 * the synchronous signature startHyprlandCursorPolling uses.
 */
export function startKWinCursorPolling(): (() => void) | null {
	if (process.platform !== "linux" || !isKdeWaylandSession()) {
		return null;
	}

	const token = randomBytes(16).toString("hex");
	const scriptDir = mkdtempSync(path.join(tmpdir(), "recordly-kwin-"));
	const qmlPath = path.join(scriptDir, "cursor-bridge.qml");
	let stopped = false;
	let scriptLoaded = false;

	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== `/${token}`) {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_PAYLOAD_BYTES) {
				request.destroy();
			}
		});
		request.on("end", () => {
			response.writeHead(204).end();
			try {
				const parsed = JSON.parse(body) as { x?: unknown; y?: unknown };
				if (typeof parsed.x === "number" && typeof parsed.y === "number") {
					// KWin reports logical layout coordinates; the telemetry cache
					// expects physical pixels like the X11 hook provides.
					const scale = getScreen().getPrimaryDisplay().scaleFactor || 1;
					setLinuxCursorScreenPoint({
						x: parsed.x * scale,
						y: parsed.y * scale,
						updatedAt: Date.now(),
					});
				}
			} catch {
				// The bridge only ever sends two integers; ignore anything else.
			}
		});
	});

	server.on("error", (error) => {
		console.warn("[CursorTelemetry] KWin cursor bridge socket failed:", error);
	});

	server.listen(0, "127.0.0.1", () => {
		if (stopped) {
			server.close();
			return;
		}
		const address = server.address();
		if (typeof address === "string" || address === null) {
			return;
		}
		writeFileSync(qmlPath, buildBridgeQml(address.port, token), "utf-8");
		// A leftover script from a crashed run would keep posting to a dead port.
		callKWin(SCRIPTING, "unloadScript", [KWIN_SCRIPT_NAME]);
		const scriptId = parseKWinScriptId(
			callKWin(SCRIPTING, "loadDeclarativeScript", [qmlPath, KWIN_SCRIPT_NAME]),
		);
		if (scriptId === null) {
			console.warn("[CursorTelemetry] Could not load the KWin cursor bridge script.");
			return;
		}
		scriptLoaded = true;
		callKWin(
			{ objectPath: `/Scripting/Script${scriptId}`, interfaceName: "org.kde.kwin.Script" },
			"run",
			[],
		);
		console.log("[CursorTelemetry] KWin cursor bridge active.");
	});

	return () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (scriptLoaded) {
			// A left-behind script would keep firing at a closed port, so unload it
			// even though this costs one short synchronous call on the session bus.
			callKWin(SCRIPTING, "unloadScript", [KWIN_SCRIPT_NAME]);
		}
		server.close();
		rmSync(scriptDir, { recursive: true, force: true });
	};
}
