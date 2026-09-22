import type { Application } from "pixi.js";

type PixiInitializationState = "initializing" | "initialized" | "failed";
type PixiInitOptions = Parameters<Application["init"]>[0];

export type PixiRendererBackend = "webgl" | "webgpu";

const RENDERER_TYPE_WEBGL = 1;
const RENDERER_TYPE_WEBGPU = 2;

// Pixi sizes its batcher layouts once per process and keys them on nothing
// renderer-specific. A renderer created later with a smaller per-stage texture
// limit reuses the oversized layout and fails to build any bind group, so every
// Pixi application in this process has to stay on the first backend that wins.
let activeBackend: PixiRendererBackend | null = null;

const initializationStates = new WeakMap<Application, PixiInitializationState>();
const destroyRequests = new WeakSet<Application>();
const destroyContexts = new WeakMap<Application, string>();
const completedCleanups = new WeakSet<Application>();

const RENDERER_DESTROY_OPTIONS = {
	removeView: true,
	releaseGlobalResources: false,
} as const;

const STAGE_DESTROY_OPTIONS = {
	children: true,
	texture: false,
	textureSource: false,
} as const;

export function getActivePixiBackend(): PixiRendererBackend | null {
	return activeBackend;
}

export function orderBackendsByActiveRenderer<T extends PixiRendererBackend>(
	backendOrder: readonly T[],
): T[] {
	if (!activeBackend) return [...backendOrder];
	const index = backendOrder.indexOf(activeBackend as T);
	if (index <= 0) return [...backendOrder];
	return [backendOrder[index], ...backendOrder.filter((_, position) => position !== index)];
}

function recordActiveBackend(app: Application): void {
	if (activeBackend) return;
	const rendererType = (app as { renderer?: { type?: number } }).renderer?.type;
	if (rendererType === RENDERER_TYPE_WEBGL) activeBackend = "webgl";
	else if (rendererType === RENDERER_TYPE_WEBGPU) activeBackend = "webgpu";
}

function reportCleanupError(app: Application, error: unknown): void {
	const context = destroyContexts.get(app) ?? "Pixi application";
	console.warn(`[PixiApplication] Failed to clean up ${context}:`, error);
}

function destroyFailedApplication(app: Application): void {
	const partialApp = app as Partial<Application>;

	try {
		partialApp.stage?.destroy(STAGE_DESTROY_OPTIONS);
	} catch (error) {
		reportCleanupError(app, error);
	}

	try {
		partialApp.renderer?.destroy(RENDERER_DESTROY_OPTIONS);
	} catch (error) {
		reportCleanupError(app, error);
	}
}

function completeDestroy(app: Application): void {
	if (completedCleanups.has(app)) return;
	completedCleanups.add(app);

	if (initializationStates.get(app) !== "initialized") {
		destroyFailedApplication(app);
		return;
	}

	try {
		app.destroy(RENDERER_DESTROY_OPTIONS, STAGE_DESTROY_OPTIONS);
	} catch (error) {
		reportCleanupError(app, error);
	}
}

export async function initializePixiApplication(
	app: Application,
	options: PixiInitOptions,
): Promise<void> {
	if (initializationStates.has(app) || destroyRequests.has(app)) {
		throw new Error("Pixi application lifecycle has already started");
	}

	initializationStates.set(app, "initializing");
	try {
		await app.init(options);
		initializationStates.set(app, "initialized");
		recordActiveBackend(app);
	} catch (error) {
		initializationStates.set(app, "failed");
		if (destroyRequests.has(app)) completeDestroy(app);
		throw error;
	}

	if (destroyRequests.has(app)) completeDestroy(app);
}

export async function initializePixiApplicationWithTimeout(
	app: Application,
	options: PixiInitOptions,
	timeoutMs: number,
	backendLabel: string,
): Promise<void> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(
				new Error(
					`Initialization timed out after ${timeoutMs}ms for ${backendLabel} renderer`,
				),
			);
		}, timeoutMs);
	});

	try {
		await Promise.race([initializePixiApplication(app, options), timeoutPromise]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

export function destroyPixiApplication(app: Application | null, context: string): void {
	if (!app || destroyRequests.has(app) || completedCleanups.has(app)) return;

	destroyRequests.add(app);
	destroyContexts.set(app, context);
	if (initializationStates.get(app) !== "initializing") completeDestroy(app);
}
