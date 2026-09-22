import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import {
	AUTOMATION_API_VERSION,
	type AutomationCommand,
	AutomationError,
	parseAutomationCommand,
} from "./protocol";

async function readCommand(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 8192) throw new AutomationError("BODY_TOO_LARGE", "Command exceeds 8 KiB.", 413);
		chunks.push(Buffer.from(chunk));
	}
	try {
		return parseAutomationCommand(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		if (error instanceof AutomationError) throw error;
		throw new AutomationError("INVALID_JSON", "Request body must be valid JSON.");
	}
}

export async function startAutomationServer(options: {
	connectionFile: string;
	dispatch: (command: AutomationCommand) => Promise<unknown>;
}) {
	if (!path.isAbsolute(options.connectionFile))
		throw new Error("Automation connection file must be an absolute path.");
	const token = randomBytes(32).toString("hex");
	const expectedAuthorization = Buffer.from(`Bearer ${token}`);
	let host = "";
	const server = createServer(async (request, response) => {
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Cache-Control", "no-store");
		try {
			if (request.headers.host !== host || request.headers.origin !== undefined) {
				throw new AutomationError(
					"FORBIDDEN",
					"Only local non-browser clients are allowed.",
					403,
				);
			}
			const authorization = Buffer.from(request.headers.authorization ?? "");
			if (
				authorization.length !== expectedAuthorization.length ||
				!timingSafeEqual(authorization, expectedAuthorization)
			) {
				throw new AutomationError("UNAUTHORIZED", "Invalid automation credentials.", 401);
			}
			if (request.method !== "POST" || request.url !== "/v1/command") {
				throw new AutomationError("NOT_FOUND", "Use POST /v1/command.", 404);
			}
			if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
				throw new AutomationError(
					"INVALID_CONTENT_TYPE",
					"Content-Type must be application/json.",
					415,
				);
			}
			const result = await options.dispatch(await readCommand(request));
			response.end(JSON.stringify({ result }));
		} catch (error) {
			const failure =
				error instanceof AutomationError
					? error
					: new AutomationError(
							"INTERNAL_ERROR",
							"Recordly could not execute the command.",
							500,
						);
			response.writeHead(failure.status);
			response.end(
				JSON.stringify({ error: { code: failure.code, message: failure.message } }),
			);
		}
	});
	server.maxConnections = 32;
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Automation server has no port.");
	host = `127.0.0.1:${address.port}`;
	const connection = {
		apiVersion: AUTOMATION_API_VERSION,
		endpoint: `http://${host}/v1/command`,
		token,
		pid: process.pid,
	};
	try {
		mkdirSync(path.dirname(options.connectionFile), { recursive: true, mode: 0o700 });
		writeFileSync(options.connectionFile, `${JSON.stringify(connection)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		server.close();
		throw new Error(
			`Cannot create automation connection file ${options.connectionFile}: ${String(error)}. If Recordly exited unexpectedly, remove its stale connection file before restarting.`,
		);
	}
	return {
		close() {
			server.closeAllConnections();
			server.close();
			try {
				if (JSON.parse(readFileSync(options.connectionFile, "utf8")).token === token) {
					unlinkSync(options.connectionFile);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					console.warn("Unable to remove automation connection file:", error);
			}
		},
	};
}
