import type { Env, ObservabilityErrorPayload } from '../types';

type ErrorContext = Record<string, unknown>;

export async function reportErrorToObservability(env: Env, event: string, error: unknown, context: ErrorContext = {}): Promise<void> {
	const payload = buildErrorPayload(env, event, error, context);
	const workerName = resolveWorkerName(env);
	console.error({
		level: 'error',
		event: payload.event,
		title: `[${workerName}] ${payload.event}`,
		worker_name: workerName,
		message: payload.message,
		stack: payload.stack,
		timestamp: payload.timestamp,
		...(payload.context || {}),
	});

	const service = env.OBS_SERVICE;
	if (!service) {
		console.warn({
			level: 'warn',
			event: 'observability_service_not_configured',
			title: `[${workerName}] observability_service_not_configured`,
			worker_name: workerName,
			original_event: payload.event,
			timestamp: new Date().toISOString(),
		});
		return;
	}

	try {
		await service.reportError(payload);
	} catch (forwardError: unknown) {
		console.error({
			level: 'error',
			event: 'error_forward_to_observability_failed',
			title: `[${workerName}] error_forward_to_observability_failed`,
			worker_name: workerName,
			message: getErrorMessage(forwardError),
			original_event: payload.event,
			timestamp: new Date().toISOString(),
		});
	}
}

function buildErrorPayload(env: Env, event: string, error: unknown, context: ErrorContext): ObservabilityErrorPayload {
	return {
		source: resolveWorkerName(env),
		event,
		message: getErrorMessage(error),
		stack: error instanceof Error ? error.stack : undefined,
		context,
		timestamp: new Date().toISOString(),
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveWorkerName(env: Env): string {
	return env.WORKER_NAME || 'unknown-worker';
}
