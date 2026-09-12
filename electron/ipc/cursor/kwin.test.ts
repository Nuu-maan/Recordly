import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: vi.fn(() => "/tmp"),
	},
}));

import { isKdeWaylandSession, parseKWinScriptId } from "./kwin";

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

	it("rejects KDE on X11", () => {
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
	it("reads the id out of a bare gdbus tuple", () => {
		expect(parseKWinScriptId("(0,)")).toBe("0");
	});

	it("is not fooled by the type keyword in a typed gdbus tuple", () => {
		expect(parseKWinScriptId("(int32 3,)")).toBe("3");
	});

	it("reads the id out of a busctl reply", () => {
		expect(parseKWinScriptId("i 0")).toBe("0");
	});

	it("returns null when KWin refused to load the script", () => {
		expect(parseKWinScriptId("(int32 -1,)")).toBeNull();
		expect(parseKWinScriptId("(-1,)")).toBeNull();
		expect(parseKWinScriptId(null)).toBeNull();
		expect(parseKWinScriptId("")).toBeNull();
	});
});
