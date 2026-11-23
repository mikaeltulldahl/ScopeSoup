// The sizes the reader and the writer agree on, in one place, so Scope Soup never writes a file it
// would then refuse to read.

/** The most an `item.md` or a `log.jsonl` may hold for the reader; a larger one is left unread. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * The most a log may hold after one of this machine's appends. Below the read limit, so that the
 * lines other machines add before the next fetch (up to 256 KB per item) still fit when the logs
 * are merged. A merge is never refused for size: refusing it would stop the sharing of every other
 * item; a merged log over the read limit spoils only its own item's log.
 */
export const MAX_APPEND_LOG_BYTES = 768 * 1024;

/** The most one log line may hold. A longer line is refused: a caller shortens what it writes (a session summary) to fit. */
export const MAX_LINE_BYTES = 16 * 1024;
