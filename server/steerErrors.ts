// Kept free of imports: harness adapters use it inside the worker process.

/**
 * The code on a harness's error when it can never take this message into a running turn (images
 * where it steers text only, a version without steering), as opposed to not now (the turn is
 * starting or ending). The worker's HTTP boundary keeps it.
 */
export const STEER_UNSUPPORTED = "steer_unsupported";

export const unsupportedSteer = <E extends Error>(error: E): E => Object.assign(error, { code: STEER_UNSUPPORTED });

export const isUnsupportedSteer = (error: unknown) => (error as { code?: unknown } | undefined)?.code === STEER_UNSUPPORTED;
