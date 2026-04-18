/** Default timeout for proxy requests (30s) */
export const PROXY_TIMEOUT_MS = 30_000;

/** Heartbeat interval (30s) */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Backpressure: window size for ACK (256KB) */
export const DEFAULT_WINDOW_SIZE = 256 * 1024;

/** Backpressure: ACK every 64KB consumed */
export const ACK_THRESHOLD = 64 * 1024;

/** Session cleanup interval (60s) */
export const CLEANUP_INTERVAL_MS = 60_000;

/** Max session age (24h) */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Chunk size for streaming body data (64KB) */
export const STREAM_CHUNK_SIZE = 64 * 1024;
