// An error from reaching friends that the owner can fix, said to them as it is. Kept apart from
// transport.ts so the transports (tunnel.ts) can throw it without importing what imports them.
export class TransportError extends Error {}
