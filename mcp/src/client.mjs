import { readFile } from "node:fs/promises";

export function createRecordlyClient(connectionFile) {
	return async (method, params, signal) => {
		let connection;
		try {
			connection = JSON.parse(await readFile(connectionFile, "utf8"));
		} catch {
			throw new Error(
				"Cannot read the Recordly connection file. Start Recordly with automation enabled and check --connection.",
			);
		}
		if (
			connection?.apiVersion !== 1 ||
			typeof connection.endpoint !== "string" ||
			!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/command$/.test(connection.endpoint) ||
			typeof connection.token !== "string" ||
			!/^[a-f0-9]{64}$/.test(connection.token)
		) {
			throw new Error("Invalid or unsupported Recordly connection file.");
		}
		let response;
		try {
			response = await fetch(connection.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${connection.token}`,
				},
				body: JSON.stringify({ method, params }),
				redirect: "error",
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
					: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new Error(
				"Recordly is unavailable or the request timed out. Check that the desktop app is running. Query recording status before retrying a command.",
			);
		}
		const body = await response.json();
		if (!response.ok || body.error) {
			throw new Error(
				`${body.error?.code ?? response.status}: ${body.error?.message ?? "Recordly request failed."}`,
			);
		}
		return body.result;
	};
}
