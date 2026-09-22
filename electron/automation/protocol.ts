export const AUTOMATION_API_VERSION = 1;

export type AutomationCommand =
	| { method: "list_sources"; params: Record<string, never> }
	| { method: "get_recording_status"; params: { recordingId?: string } }
	| { method: "start_recording"; params: { requestId: string; sourceId: string } }
	| { method: "stop_recording"; params: { recordingId: string } };

export type RecordingPhase =
	| "starting"
	| "recording"
	| "finalizing"
	| "completed"
	| "cancelled"
	| "failed";

export interface AutomationRecording {
	recordingId: string;
	sourceId: string;
	phase: RecordingPhase;
	createdAt: string;
	updatedAt: string;
	paused?: boolean;
	videoPath?: string;
	webcamPath?: string | null;
	error?: string;
}

export type RecordingUpdate = Pick<AutomationRecording, "recordingId" | "phase"> &
	Partial<Pick<AutomationRecording, "paused" | "videoPath" | "webcamPath" | "error">>;

export interface AutomationSource {
	id: string;
	name: string;
	type: "screen" | "window";
	requiresSelection: boolean;
}

export interface AutomationApproval {
	sourceName: string;
	microphone: boolean;
	systemAudio: boolean;
	webcam: boolean;
}

export interface RendererAutomationCommand {
	id: string;
	command: Exclude<AutomationCommand, { method: "get_recording_status" }>;
}

export interface RendererAutomationResult {
	id: string;
	result?: unknown;
	error?: string;
}

export class AutomationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		this.name = "AutomationError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAutomationCommand(value: unknown): AutomationCommand {
	if (!isRecord(value) || typeof value.method !== "string" || !isRecord(value.params)) {
		throw new AutomationError("INVALID_COMMAND", "Expected a method and params object.");
	}
	if (Object.keys(value).some((key) => key !== "method" && key !== "params")) {
		throw new AutomationError("INVALID_COMMAND", "Unknown command property.");
	}
	const params = value.params;
	const allowed: Record<string, string[]> = {
		list_sources: [],
		get_recording_status: ["recordingId"],
		start_recording: ["requestId", "sourceId"],
		stop_recording: ["recordingId"],
	};
	if (!Object.keys(allowed).includes(value.method)) {
		throw new AutomationError("UNKNOWN_METHOD", "Unknown automation method.");
	}
	if (Object.keys(params).some((key) => !allowed[value.method as string].includes(key))) {
		throw new AutomationError("INVALID_PARAMS", "Unknown command parameter.");
	}
	const id = (key: string) => {
		const result = params[key];
		if (typeof result !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(result)) {
			throw new AutomationError("INVALID_PARAMS", `${key} must be an 8–128 character ID.`);
		}
		return result;
	};
	switch (value.method) {
		case "list_sources":
			return { method: value.method, params: {} };
		case "get_recording_status":
			return {
				method: value.method,
				params: params.recordingId === undefined ? {} : { recordingId: id("recordingId") },
			};
		case "start_recording": {
			if (
				typeof params.sourceId !== "string" ||
				params.sourceId.length > 256 ||
				(!params.sourceId.startsWith("screen:") && !params.sourceId.startsWith("window:"))
			) {
				throw new AutomationError(
					"INVALID_PARAMS",
					"sourceId must come from list_sources.",
				);
			}
			return {
				method: value.method,
				params: { requestId: id("requestId"), sourceId: params.sourceId },
			};
		}
		default:
			return { method: "stop_recording", params: { recordingId: id("recordingId") } };
	}
}

export function isTerminalPhase(phase: RecordingPhase) {
	return phase === "completed" || phase === "failed" || phase === "cancelled";
}
