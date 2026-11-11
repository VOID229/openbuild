// Bun 1.3.8 can stall while asynchronously loading typebox's large module graph in a
// fresh eval process. Load it synchronously before server imports (and test mocks).
// A stalled import otherwise waits for bun:test to SIGTERM the child at its deadline.
require("typebox");
