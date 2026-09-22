import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startAutomationServer } from "./server";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

it("authenticates local commands, rejects browser requests, and removes its credentials on close", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "recordly-automation-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const connectionFile = path.join(directory, "connection.json");
	const dispatch = vi.fn().mockResolvedValue({ phase: "idle" });
	const server = await startAutomationServer({ connectionFile, dispatch });
	cleanup.push(() => server.close());
	const connection = JSON.parse(await readFile(connectionFile, "utf8"));
	if (process.platform !== "win32") expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
	const headers = {
		"content-type": "application/json",
		authorization: `Bearer ${connection.token}`,
	};
	const body = JSON.stringify({ method: "get_recording_status", params: {} });
	const post = (overrides = {}, payload = body) =>
		fetch(connection.endpoint, {
			method: "POST",
			headers: { ...headers, ...overrides },
			body: payload,
		});
	expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
	expect((await post({ origin: "https://example.com" })).status).toBe(403);
	const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
		const req = request(
			connection.endpoint,
			{ method: "POST", headers: { ...headers, host: "attacker.example" } },
			(response) => {
				response.resume();
				resolve(response.statusCode);
			},
		);
		req.on("error", reject);
		req.end(body);
	});
	expect(invalidHostStatus).toBe(403);
	expect((await post({}, "{")).status).toBe(400);
	expect((await post({}, JSON.stringify({ method: "read_file", params: {} }))).status).toBe(400);
	expect(dispatch).not.toHaveBeenCalled();
	expect(await (await post()).json()).toEqual({ result: { phase: "idle" } });
	expect(dispatch).toHaveBeenCalledTimes(1);
	await expect(startAutomationServer({ connectionFile, dispatch })).rejects.toThrow(
		"Cannot create",
	);
	server.close();
	await expect(readFile(connectionFile)).rejects.toMatchObject({ code: "ENOENT" });
});
