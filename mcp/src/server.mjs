import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const recordingId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const tools = [
	{
		name: "list_sources",
		description: "List Recordly screen and window capture sources. On Wayland the portal source requires the user to choose a surface in the system picker.",
		inputSchema: z.object({}).strict(),
		readOnly: true,
	},
	{
		name: "start_recording",
		description: "Request a Recordly recording of a source from list_sources. Uses the microphone, system audio, webcam and countdown settings currently configured in Recordly. The desktop app asks the user to approve capture. Returns starting immediately; poll get_recording_status until recording before performing the demo. Supply a unique requestId and reuse it on retries; it becomes the recordingId. The most recent 100 recording IDs are retained until Recordly exits.",
		inputSchema: z.object({
			requestId: recordingId.describe("Unique request ID (for example a UUID); reuse exactly this ID for retries."),
			sourceId: z.string().min(1).max(256).regex(/^(screen|window):/).describe("Source ID returned by list_sources."),
		}).strict(),
		readOnly: false,
	},
	{
		name: "get_recording_status",
		description: "Read an automation recording's phase: starting, recording, finalizing, completed, cancelled or failed. Without an ID returns the latest automation recording, or idle. A completed result includes the raw videoPath and optional webcamPath; polished editor export is separate. The paused flag reflects the user's pause control.",
		inputSchema: z.object({ recordingId: recordingId.optional() }).strict(),
		readOnly: true,
	},
	{
		name: "stop_recording",
		description: "Stop and save the specified automation recording. Returns finalizing; poll get_recording_status until completed or failed. Retrying the same recordingId never starts a new recording. Cannot stop a manually started recording or a recording still awaiting approval.",
		inputSchema: z.object({ recordingId }).strict(),
		readOnly: false,
	},
];

export function createMcpServer(callRecordly) {
	const server = new McpServer({ name: "recordly", version: "0.1.0" });
	for (const tool of tools) {
		server.registerTool(tool.name, {
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: {
				readOnlyHint: tool.readOnly,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		}, async (params, context) => {
			try {
				const result = await callRecordly(tool.name, params, context.signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
			} catch (error) {
				return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
			}
		});
	}
	return server;
}
