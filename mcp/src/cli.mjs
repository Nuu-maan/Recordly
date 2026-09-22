#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createRecordlyClient } from "./client.mjs";
import { createMcpServer } from "./server.mjs";

try {
	const { values } = parseArgs({ options: { connection: { type: "string" }, help: { type: "boolean", short: "h" } } });
	if (values.help) {
		console.error("Usage: recordly-mcp --connection /absolute/path/to/automation.json\nAlternatively set RECORDLY_CONNECTION_FILE. Start Recordly with automation enabled. MCP uses stdio; diagnostics use stderr.");
	} else {
		const connectionFile = values.connection ?? process.env.RECORDLY_CONNECTION_FILE;
		if (!connectionFile || !path.isAbsolute(connectionFile)) throw new Error("Provide --connection with an absolute path to Recordly's automation connection file.");
		const handle = serveStdio(() => createMcpServer(createRecordlyClient(connectionFile)), {
			onerror: (error) => console.error(error.message),
		});
		for (const signal of ["SIGINT", "SIGTERM"]) {
			process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
