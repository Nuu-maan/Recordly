import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
	},
}));

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	buildBridgeQml,
	DBUS_CLIENTS,
	isKdeWaylandSession,
	isPlausibleCursorPoint,
	parseKWinScriptId,
	startKWinCursorBridge,
} from "./kwin";

describe("isKdeWaylandSession", () => {
	it("accepts a Plasma Wayland session", () => {
		expect(
			isKdeWaylandSession({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" }),
		).toBe(true);
	});

	it("accepts a session identified only by WAYLAND_DISPLAY", () => {
		expect(
			isKdeWaylandSession({ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_DESKTOP: "plasma" }),
		).toBe(true);
	});

	it("rejects KDE on X11, where uiohook already works", () => {
		expect(isKdeWaylandSession({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE" })).toBe(
			false,
		);
	});

	it("rejects other Wayland compositors", () => {
		expect(
			isKdeWaylandSession({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "Hyprland" }),
		).toBe(false);
	});
});

describe("parseKWinScriptId", () => {
	it("reads a bare gdbus tuple", () => {
		expect(parseKWinScriptId("(0,)")).toBe("0");
	});

	it("is not fooled by the type keyword in a typed gdbus tuple", () => {
		expect(parseKWinScriptId("(int32 3,)")).toBe("3");
		expect(parseKWinScriptId("(uint32 7,)")).toBe("7");
	});

	it("reads a busctl reply", () => {
		expect(parseKWinScriptId("i 12")).toBe("12");
	});

	it("returns null when KWin refused to load the script", () => {
		expect(parseKWinScriptId("(int32 -1,)")).toBeNull();
		expect(parseKWinScriptId("(-1,)")).toBeNull();
		expect(parseKWinScriptId(null)).toBeNull();
		expect(parseKWinScriptId("")).toBeNull();
	});
});

describe("isPlausibleCursorPoint", () => {
	it("accepts an ordinary position", () => {
		expect(isPlausibleCursorPoint({ x: 674, y: 513 })).toBe(true);
		expect(isPlausibleCursorPoint({ x: 0, y: 0 })).toBe(true);
	});

	it("rejects the non-finite values JSON can smuggle in", () => {
		// JSON.parse('{"x":1e999}') yields Infinity, which would reach the display
		// lookup in telemetry and produce NaN samples.
		expect(isPlausibleCursorPoint(JSON.parse('{"x":1e999,"y":0}'))).toBe(false);
		expect(isPlausibleCursorPoint({ x: Number.NaN, y: 0 })).toBe(false);
	});

	it("rejects absurd coordinates", () => {
		expect(isPlausibleCursorPoint({ x: 1e9, y: 0 })).toBe(false);
	});

	it("rejects anything that is not a pair of numbers", () => {
		expect(isPlausibleCursorPoint(null)).toBe(false);
		expect(isPlausibleCursorPoint({ x: "674", y: 513 })).toBe(false);
		expect(isPlausibleCursorPoint({ x: 674 })).toBe(false);
	});
});

describe("D-Bus argument construction", () => {
	const target = { objectPath: "/Scripting", interfaceName: "org.kde.kwin.Scripting" };
	const gdbus = DBUS_CLIENTS.find((client) => client.bin === "gdbus");
	const busctl = DBUS_CLIENTS.find((client) => client.bin === "busctl");

	it("names the method on the destination for gdbus", () => {
		expect(gdbus?.buildArgs(target, "unloadScript", ["bridge"])).toEqual([
			"call",
			"--session",
			"--dest",
			"org.kde.KWin",
			"--object-path",
			"/Scripting",
			"--method",
			"org.kde.kwin.Scripting.unloadScript",
			"bridge",
		]);
	});

	it("passes a signature matching the argument count for busctl", () => {
		expect(
			busctl?.buildArgs(target, "loadDeclarativeScript", ["/tmp/a.qml", "bridge"]),
		).toContain("ss");
		expect(busctl?.buildArgs(target, "unloadScript", ["bridge"])).toContain("s");
	});

	it("passes an empty signature for a zero-argument call", () => {
		// busctl reads "" as a zero-argument call; dropping it entirely would make
		// busctl treat the next word as the signature.
		const args = busctl?.buildArgs(
			{ objectPath: "/Scripting/Script0", interfaceName: "org.kde.kwin.Script" },
			"run",
			[],
		);
		expect(args?.at(-1)).toBe("");
	});
});

describe("buildBridgeQml", () => {
	const qml = buildBridgeQml(45999, "a".repeat(32), "c".repeat(32), 33);

	it("targets the generated port and token", () => {
		expect(qml).toContain(
			'request.open("POST", "http://127.0.0.1:45999/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")',
		);
	});

	it("coalesces to the sample interval", () => {
		expect(qml).toContain("interval: 33");
	});

	it("disarms itself once posting keeps failing", () => {
		// A KWin script cannot unload itself, so this is what bounds the damage
		// when the app dies without unloading the bridge.
		expect(qml).toContain("failures >= 3");
		expect(qml).toContain("sampler.running = false");
	});

	it("disarms on the first reply that does not echo the acknowledgement", () => {
		expect(qml).toContain(
			'request.getResponseHeader("X-Recordly-Bridge") !== "cccccccccccccccccccccccccccccccc"',
		);
	});

	it("never reports the sentinel position before a real one arrives", () => {
		expect(qml).toContain("if (pendingX < 0 && pendingY < 0)");
		expect(qml).toContain("pendingX = Workspace.cursorPos.x");
	});

	it("heartbeats while the pointer is still, so a dead server is noticed", () => {
		// Without this the script only discovers a dead server when the user next
		// moves the mouse, which is exactly when it should already be silent.
		// Must stay under LINUX_CURSOR_CACHE_TTL_MS or the cached position ages
		// out between heartbeats and the recording gets holes of (0, 0).
		expect(qml).toContain("Date.now() - lastPostMs < 500");
	});

	it("coerces interpolated numbers so a future non-numeric constant cannot escape", () => {
		const hostile = buildBridgeQml(
			"1234; evil()" as unknown as number,
			"b".repeat(32),
			"d".repeat(32),
			"33; evil()" as unknown as number,
		);
		expect(hostile).not.toContain("evil()");
		expect(hostile).toContain("interval: NaN");
	});
});

describe("startKWinCursorBridge", () => {
	it("declines to start outside a KDE Wayland session", () => {
		const previous = { ...process.env };
		process.env.XDG_SESSION_TYPE = "x11";
		process.env.XDG_CURRENT_DESKTOP = "GNOME";
		delete process.env.WAYLAND_DISPLAY;
		try {
			expect(startKWinCursorBridge(() => {})).toBeNull();
		} finally {
			process.env = previous;
		}
	});
});

describe("temp directory handling", () => {
	it("leaves no generated QML behind when stopped before startup finishes", async () => {
		if (process.platform !== "linux") {
			return;
		}
		const previous = { ...process.env };
		process.env.XDG_SESSION_TYPE = "wayland";
		process.env.XDG_CURRENT_DESKTOP = "KDE";
		const listBridgeDirs = () =>
			readdirSync(tmpdir()).filter((entry) => entry.startsWith("recordly-kwin-"));
		const before = new Set(listBridgeDirs());
		try {
			const stop = startKWinCursorBridge(() => {});
			expect(stop).not.toBeNull();
			expect(listBridgeDirs().filter((entry) => !before.has(entry))).toHaveLength(1);
			// Stopping before the listen callback runs is the case most likely to
			// strand the directory.
			stop?.();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(listBridgeDirs().filter((entry) => !before.has(entry))).toEqual([]);
		} finally {
			process.env = previous;
		}
	});
});
