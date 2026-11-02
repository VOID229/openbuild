# Nightly consolidation — 0.1.7-nightly.2

Base: main at d30168e (stable 0.1.7 / nightly 0.1.7-nightly.1), including Grok and Hermes.

Included outstanding working trees, preserved as parent commits:

- Main installation: Hermes brand asset, detached Git revision display, paired-device request fixes.
- `openbuild/i-noticed-that-sometimes`: client lifecycle, persistence, transport, queue, Pi RPC, and Durable cancellation/projection work and audit tests.
- `openbuild/the-way-openbuild-shows`: tool-call presentation changes.

Reviewed other branches with commits outside main. The reasoning-effort preference implementation and tests are already in main, along with the slash-command, sidebar layout, picker placement, no-restart documentation, and plugin functionality. Their old branch ancestry differs from main because changes were copied/reworked; do not merge the obsolete plugin baseline over current code.

Integration changes preserve the current detached worker architecture, native runtime support, steering and questions. Stop intent crosses the worker boundary; legacy queues migrate without losing attachments. Existing runtime protocol fixtures were updated for raw active-branch rewind history. Full verification results are recorded in the GitHub release notes.

Publishing this release does not restart the running installation. Updates still require a clean installation checkout, followed by an explicit restart by its owner.
