import {
	type AutomationCommand,
	AutomationError,
	type AutomationRecording,
	isTerminalPhase,
	type RecordingUpdate,
} from "./protocol";

export class RecordingController {
	private readonly recordings = new Map<string, AutomationRecording>();
	private latestId: string | undefined;

	constructor(
		private readonly execute: (
			command: Exclude<AutomationCommand, { method: "get_recording_status" }>,
		) => Promise<unknown>,
	) {}

	async call(command: AutomationCommand): Promise<unknown> {
		if (command.method === "list_sources") return this.execute(command);
		if (command.method === "get_recording_status") {
			const id = command.params.recordingId ?? this.latestId;
			return id ? { ...this.get(id) } : { phase: "idle" };
		}
		if (command.method === "start_recording") {
			const { requestId, sourceId } = command.params;
			const previous = this.recordings.get(requestId);
			if (previous) {
				if (previous.sourceId !== sourceId) {
					throw new AutomationError(
						"ID_CONFLICT",
						"This requestId belongs to another source.",
						409,
					);
				}
				return { ...previous };
			}
			if ([...this.recordings.values()].some((item) => !isTerminalPhase(item.phase))) {
				throw new AutomationError(
					"BUSY",
					"A recording is already starting, active, or saving.",
					409,
				);
			}
			const timestamp = new Date().toISOString();
			const recording: AutomationRecording = {
				recordingId: requestId,
				sourceId,
				phase: "starting",
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			this.recordings.set(requestId, recording);
			this.latestId = requestId;
			if (this.recordings.size > 100) {
				const oldest = this.recordings.keys().next().value;
				if (oldest) this.recordings.delete(oldest);
			}
			void this.execute(command).catch((error: unknown) => {
				this.update({ recordingId: requestId, phase: "failed", error: String(error) });
			});
			return { ...recording };
		}
		const recording = this.get(command.params.recordingId);
		if (isTerminalPhase(recording.phase) || recording.phase === "finalizing") {
			return { ...recording };
		}
		if (recording.phase === "starting") {
			throw new AutomationError(
				"NOT_READY",
				"Recording is still awaiting approval or starting.",
				409,
			);
		}
		this.update({ recordingId: recording.recordingId, phase: "finalizing" });
		void this.execute(command).catch((error: unknown) => {
			this.update({
				recordingId: recording.recordingId,
				phase: "failed",
				error: String(error),
			});
		});
		return { ...this.get(recording.recordingId) };
	}

	update(update: RecordingUpdate) {
		const current = this.recordings.get(update.recordingId);
		if (!current || isTerminalPhase(current.phase)) return;
		if (current.phase === "finalizing" && update.phase === "recording") return;
		this.recordings.set(update.recordingId, {
			...current,
			...update,
			updatedAt: new Date().toISOString(),
		});
	}

	rendererClosed() {
		for (const recording of this.recordings.values()) {
			this.update({
				recordingId: recording.recordingId,
				phase: "failed",
				error: "The recording window closed before recording finished. Check Recordly for recovery.",
			});
		}
	}

	private get(id: string) {
		const recording = this.recordings.get(id);
		if (!recording) {
			throw new AutomationError("NOT_FOUND", "Recording ID is unknown or expired.", 404);
		}
		return recording;
	}
}
