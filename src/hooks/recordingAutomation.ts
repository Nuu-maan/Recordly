import type {
	AutomationApproval,
	AutomationSource,
	RecordingUpdate,
	RendererAutomationCommand,
	RendererAutomationResult,
} from "../../electron/automation/protocol";

export interface RecordingAutomationDriver {
	isBusy(): boolean;
	listSources(): Promise<ProcessedDesktopSource[]>;
	settings(): Omit<AutomationApproval, "sourceName">;
	approve(id: string, details: AutomationApproval): Promise<boolean>;
	selectSource(source: ProcessedDesktopSource): Promise<unknown>;
	start(): Promise<void>;
	stop(): void;
	cancelStart(): void;
	report(update: RecordingUpdate): Promise<void>;
	reply(result: RendererAutomationResult): void;
}

export function createRecordingAutomation(getDriver: () => RecordingAutomationDriver) {
	let recordingId: string | undefined;
	let phase: RecordingUpdate["phase"] | undefined;
	let pendingStart: string | undefined;
	let cancelled = false;

	const report = async (update: Omit<RecordingUpdate, "recordingId">) => {
		if (!recordingId) return;
		if (phase === "completed" || phase === "failed" || phase === "cancelled") return;
		if (phase === "finalizing" && update.phase === "recording") return;
		phase = update.phase;
		try {
			await getDriver().report({ ...update, recordingId });
		} catch (error) {
			console.error("Unable to report recording status:", error);
		} finally {
			if (["completed", "failed", "cancelled"].includes(update.phase))
				recordingId = undefined;
		}
	};

	return {
		report,
		isActive: () => recordingId !== undefined,
		isPending: () => pendingStart !== undefined,
		cancel(id: string) {
			if (id !== pendingStart) return;
			cancelled = true;
			if (phase === "recording") getDriver().stop();
			else getDriver().cancelStart();
		},
		async handle({ id, command }: RendererAutomationCommand) {
			try {
				const driver = getDriver();
				if (command.method === "list_sources") {
					const sources: AutomationSource[] = (await driver.listSources()).map(
						(source) => ({
							id: source.id,
							name: source.name,
							type: source.id.startsWith("window:") ? "window" : "screen",
							requiresSelection: source.id === "screen:linux-portal",
						}),
					);
					driver.reply({ id, result: { sources, settings: driver.settings() } });
					return;
				}
				if (command.method === "stop_recording") {
					if (recordingId === command.params.recordingId && phase === "finalizing") {
						driver.reply({ id, result: {} });
						return;
					}
					if (recordingId !== command.params.recordingId || phase !== "recording") {
						throw new Error("This recording is not active in the recording window.");
					}
					await report({ phase: "finalizing" });
					driver.stop();
					driver.reply({ id, result: {} });
					return;
				}
				if (pendingStart || recordingId || driver.isBusy())
					throw new Error("Recordly is already recording or saving.");
				pendingStart = id;
				cancelled = false;
				try {
					const sources = await driver.listSources();
					const source = sources.find((item) => item.id === command.params.sourceId);
					if (!source)
						throw new Error(
							"The requested source is no longer available. Call list_sources again.",
						);
					const settings = driver.settings();
					if (
						cancelled ||
						!(await driver.approve(id, { sourceName: source.name, ...settings }))
					) {
						throw new Error("Recording was not approved.");
					}
					if (cancelled || getDriver().isBusy())
						throw new Error("Recording start was cancelled or Recordly became busy.");
					if (JSON.stringify(settings) !== JSON.stringify(getDriver().settings())) {
						throw new Error(
							"Recording settings changed during approval. Submit a new recording request.",
						);
					}
					await driver.selectSource(source);
					if (cancelled || getDriver().isBusy())
						throw new Error("Recording start was cancelled or Recordly became busy.");
					recordingId = command.params.requestId;
					phase = "starting";
					await getDriver().start();
					if (phase === "starting")
						throw new Error(
							"Recording did not start. Check Recordly permissions and source selection.",
						);
					driver.reply({ id, result: {} });
				} catch (error) {
					await report({
						phase: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				} finally {
					pendingStart = undefined;
				}
			} catch (error) {
				getDriver().reply({
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}
