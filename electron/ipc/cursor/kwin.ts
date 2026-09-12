import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CURSOR_SAMPLE_INTERVAL_MS, LINUX_CURSOR_CACHE_TTL_MS } from "../constants";

const SCRIPT_NAME_PREFIX = "recordly-cursor-bridge";
const TEMP_DIR_PREFIX = "recordly-kwin-";
const MAX_PAYLOAD_BYTES = 128;
const DBUS_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 5000;
// Posted even when the pointer has not moved. Two reasons: the script notices a
// dead server while the user is idle rather than only when they next move, and
// the cached position never ages out. It has to stay comfortably under the
// cache TTL, because once the cache goes stale the telemetry falls back to
// Electron's cursor point, which reads (0, 0) on Wayland and writes a hole into
// the recording for as long as the pointer stays still.
const HEARTBEAT_MS = Math.floor(LINUX_CURSOR_CACHE_TTL_MS / 2);
// The compositor is legitimately silent while the pointer is still, so this
// only downgrades an optimistic "bridge active" log into an honest warning.
const FIRST_SAMPLE_GRACE_MS = 10_000;
const STALE_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;
// A coordinate this far outside any real layout is a bug or a forgery.
const MAX_REASONABLE_COORDINATE = 100_000;

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
export const DBUS_CLIENTS: {
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
			// Every argument these three methods take is a string, and busctl reads
			// an empty signature as a zero-argument call.
			"s".repeat(args.length),
			...args,
		],
	},
];

export type KWinCallResult = { stdout: string } | { failure: string };

export function isKWinCallFailure(result: KWinCallResult): result is { failure: string } {
	return "failure" in result;
}

function runDBusClient(bin: string, args: string[]): Promise<KWinCallResult> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: DBUS_TIMEOUT_MS }, (error, stdout, stderr) => {
			if (error) {
				const detail = (stderr || error.message || "").trim().split("\n")[0];
				resolve({ failure: `${bin}: ${detail || "failed"}` });
				return;
			}
			resolve({ stdout: stdout.trim() });
		});
	});
}

// Asynchronous on purpose: this runs on the Electron main thread while the user
// is pressing Record, and a wedged session bus must never freeze the UI.
async function callKWin(
	target: DBusTarget,
	method: string,
	args: string[],
): Promise<KWinCallResult> {
	const failures: string[] = [];
	for (const client of DBUS_CLIENTS) {
		const result = await runDBusClient(client.bin, client.buildArgs(target, method, args));
		if (!isKWinCallFailure(result)) {
			return result;
		}
		failures.push(result.failure);
	}
	return { failure: failures.join("; ") };
}

/**
 * Reads the pointer from KWin and posts it back over loopback.
 *
 * The timer coalesces the signal down to the telemetry sample rate and only
 * posts positions that actually changed, so an idle pointer costs nothing.
 *
 * The self-disarming matters more than it looks. A KWin script cannot unload
 * itself, so an app that dies without unloading this one would otherwise leave
 * it broadcasting the pointer to an ephemeral port that any later local process
 * can bind and read. Two things bound that. The server echoes an acknowledgement
 * secret that only it knows, and a single wrong or missing echo disarms the
 * script, so an impostor on that port learns at most one position. A heartbeat
 * keeps posting while the pointer is still, so a dead server is noticed within
 * seconds rather than whenever the user next moves the mouse.
 */
export function buildBridgeQml(
	port: number,
	token: string,
	ack: string,
	intervalMs: number,
): string {
	return `import QtQuick
import org.kde.kwin

Item {
    property int lastX: -1
    property int lastY: -1
    property int pendingX: -1
    property int pendingY: -1
    property int failures: 0
    property double lastPostMs: 0

    function disarm() {
        sampler.running = false;
    }

    function post(x, y) {
        var request = new XMLHttpRequest();
        request.onreadystatechange = function () {
            if (request.readyState !== XMLHttpRequest.DONE) {
                return;
            }
            if (request.status !== 204) {
                failures = failures + 1;
                if (failures >= 3) {
                    disarm();
                }
                return;
            }
            if (request.getResponseHeader("X-Recordly-Bridge") !== "${ack}") {
                // Somebody else is answering on this port. Stop immediately
                // rather than keep handing them the pointer position.
                disarm();
                return;
            }
            failures = 0;
        };
        request.open("POST", "http://127.0.0.1:${Number(port)}/${token}");
        request.send('{"x":' + x + ',"y":' + y + '}');
        lastPostMs = Date.now();
    }

    Timer {
        id: sampler
        interval: ${Number(intervalMs)}
        repeat: true
        running: true
        onTriggered: {
            if (pendingX < 0 && pendingY < 0) {
                // No real position yet; never report the sentinel.
                return;
            }
            if (pendingX === lastX && pendingY === lastY) {
                if (Date.now() - lastPostMs < ${Number(HEARTBEAT_MS)}) {
                    return;
                }
                post(lastX, lastY);
                return;
            }
            lastX = pendingX;
            lastY = pendingY;
            post(lastX, lastY);
        }
    }

    Component.onCompleted: {
        // Seed from the current position so the first sample is real rather than
        // whatever the pointer happens to do first.
        pendingX = Workspace.cursorPos.x;
        pendingY = Workspace.cursorPos.y;
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

export function isPlausibleCursorPoint(value: unknown): value is { x: number; y: number } {
	const point = value as { x?: unknown; y?: unknown } | null;
	if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
		return false;
	}
	return (
		Number.isFinite(point.x) &&
		Number.isFinite(point.y) &&
		Math.abs(point.x) <= MAX_REASONABLE_COORDINATE &&
		Math.abs(point.y) <= MAX_REASONABLE_COORDINATE
	);
}

// Crashed runs leave their generated QML behind; sweep anything old enough that
// it cannot belong to a live bridge.
function removeStaleTempDirs(): void {
	const root = tmpdir();
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_TEMP_DIR_AGE_MS;
	for (const entry of entries) {
		if (!entry.startsWith(TEMP_DIR_PREFIX)) {
			continue;
		}
		const candidate = path.join(root, entry);
		try {
			if (statSync(candidate).mtimeMs < cutoff) {
				rmSync(candidate, { recursive: true, force: true });
			}
		} catch {
			// Another instance may have removed it already.
		}
	}
}

/**
 * Streams the pointer position on KDE Wayland, where uiohook's XRecord hook
 * only ever sees XWayland clients.
 *
 * Returns a stop function, or null when the session is not KDE Wayland.
 * Startup continues in the background so the caller keeps the synchronous
 * signature the other providers use, and the returned stop function is safe to
 * call at any point during that startup.
 */
export function startKWinCursorBridge(
	onPoint: (point: { x: number; y: number }) => void,
): (() => void) | null {
	if (process.platform !== "linux" || !isKdeWaylandSession()) {
		return null;
	}

	const token = randomBytes(16).toString("hex");
	// Echoed on every reply so the script can tell our server from whoever binds
	// this ephemeral port after the app is gone.
	const ack = randomBytes(16).toString("hex");
	// Unique per process so two Recordly instances in one session cannot unload
	// each other's bridge.
	const scriptName = `${SCRIPT_NAME_PREFIX}-${process.pid}-${token.slice(0, 8)}`;
	removeStaleTempDirs();
	const scriptDir = mkdtempSync(path.join(tmpdir(), TEMP_DIR_PREFIX));
	const qmlPath = path.join(scriptDir, "cursor-bridge.qml");

	let stopped = false;
	let scriptHandedToKWin = false;
	let sampleSeen = false;
	let graceTimer: NodeJS.Timeout | null = null;

	const server = createServer((request, response) => {
		if (request.method !== "POST" || request.url !== `/${token}`) {
			// Drain before replying so the socket is not left half-consumed.
			request.resume();
			response.writeHead(404).end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_PAYLOAD_BYTES) {
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			response.writeHead(204, { "X-Recordly-Bridge": ack }).end();
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
				if (isPlausibleCursorPoint(parsed)) {
					sampleSeen = true;
					onPoint({ x: parsed.x, y: parsed.y });
				}
			} catch {
				// The bridge only ever sends two integers; ignore anything else.
			}
		});
	});
	server.requestTimeout = REQUEST_TIMEOUT_MS;

	const releaseLocalResources = () => {
		if (graceTimer) {
			clearTimeout(graceTimer);
			graceTimer = null;
		}
		server.close();
		// close() alone leaves established keep-alive sockets open, and Qt's
		// XMLHttpRequest holds one.
		server.closeAllConnections();
		rmSync(scriptDir, { recursive: true, force: true });
	};

	server.on("error", (error) => {
		console.warn("[CursorTelemetry] KWin cursor bridge socket failed:", error);
		if (!stopped) {
			stopped = true;
			releaseLocalResources();
		}
	});

	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (stopped || typeof address === "string" || address === null) {
			return;
		}
		writeFileSync(
			qmlPath,
			buildBridgeQml(address.port, token, ack, CURSOR_SAMPLE_INTERVAL_MS),
			"utf-8",
		);

		void (async () => {
			const loaded = await callKWin(SCRIPTING, "loadDeclarativeScript", [
				qmlPath,
				scriptName,
			]);
			if (stopped) {
				return;
			}
			if (isKWinCallFailure(loaded)) {
				console.warn(
					"[CursorTelemetry] Could not reach KWin to load the cursor bridge:",
					loaded.failure,
				);
				return;
			}
			// KWin owns the script from here on, whatever the reply looked like, so
			// the stop path must unload it even when the id did not parse.
			scriptHandedToKWin = true;

			const scriptId = parseKWinScriptId(loaded.stdout);
			if (scriptId === null) {
				console.warn(
					"[CursorTelemetry] KWin refused the cursor bridge script:",
					loaded.stdout || "(no reply)",
				);
				return;
			}

			const started = await callKWin(
				{
					objectPath: `/Scripting/Script${scriptId}`,
					interfaceName: "org.kde.kwin.Script",
				},
				"run",
				[],
			);
			if (stopped) {
				return;
			}
			if (isKWinCallFailure(started)) {
				console.warn(
					"[CursorTelemetry] KWin cursor bridge failed to start:",
					started.failure,
				);
				return;
			}

			// loadDeclarativeScript reports success even when the QML fails to
			// instantiate, which is what happens on Plasma 5 where the workspace is
			// not the Workspace singleton this script expects. Silence is the only
			// signal available, so say so rather than claiming success.
			graceTimer = setTimeout(() => {
				if (!sampleSeen) {
					console.warn(
						"[CursorTelemetry] KWin cursor bridge produced no samples; cursor effects will have no data. This provider needs Plasma 6.",
					);
				}
			}, FIRST_SAMPLE_GRACE_MS);
			graceTimer.unref();
			console.log("[CursorTelemetry] KWin cursor bridge loaded.");
		})();
	});

	return () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (scriptHandedToKWin) {
			void callKWin(SCRIPTING, "unloadScript", [scriptName]).then((result) => {
				if (isKWinCallFailure(result)) {
					console.warn(
						"[CursorTelemetry] Could not unload the KWin cursor bridge:",
						result.failure,
					);
				}
			});
		}
		releaseLocalResources();
	};
}
