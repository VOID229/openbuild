// A reply that fails on purpose logs its redacted error, one line per bot (see runner.ts, #150). That
// line is all a bot test may leave on stderr: anything else is still unexpected.
const REDACTED_REPLY_ERROR = /^\[bots\] [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} couldn't reply: [^\n]*\n/gm;

export function unexpectedStderr(stderr: string): string {
  return stderr.replace(REDACTED_REPLY_ERROR, "");
}
