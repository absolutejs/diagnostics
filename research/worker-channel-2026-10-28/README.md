# Bounded worker diagnostics — 2026-10-28

Extends the existing diagnostics package rather than adding a task manager or
another logging transport. The game already owns worker execution/cancellation,
and diagnostics/beacon own redaction and durable delivery. This channel provides
explicit correlation, redaction, bounded JSON frames, independently enforced
receiver budgets, duplicate/out-of-order rejection, missing-sequence accounting,
owned callback records and explicit close semantics.

Read-only ecosystem review: performance owns web/resource/server timing; metrics
owns exposition; telemetry owns spans; sync owns reactive remote data; queue owns
durable server jobs. None provides this browser worker diagnostic-frame protocol.
No PAAS files are touched. Sources and evidence live in this durable worktree.

37 package tests / 175 assertions pass, including nine channel tests. Type checking
and build pass. Published-subpath consumer checks pass. The browser probe is designed to run
with GPU disabled, receives/redacts a checkpoint, acknowledges receipt, then
observes an intentional worker exception. On success it proves retention of an already
received checkpoint, not delivery after arbitrary termination or power loss.

The normative HTML worker termination algorithm discards queued tasks and can
empty the outside-port queue. Do not promise a final report after termination.
Source: https://html.spec.whatwg.org/multipage/workers.html (reviewed 2026-10-28).
The application must provide its existing host persistence policy. Inputs on the
producer are trusted/bounded; payload limits do not cap traversal of arbitrary
objects. Callbacks are synchronous. No worker/listeners/network/queue is implicit.

The first changelog check correctly rejected stale generated Markdown and could
not compare registry in the sandbox. Markdown was regenerated using the package's
canonical renderer; online comparison is a separate gate. Publication is not
claimed until archive and registry verification complete.

Initial browser execution did not start: this package uses Playwright 1.62.1 but
its matching browser download is absent. A retry explicitly selects the already
installed Chromium binary used by the physics checks, without enabling GPU.

Final browser retry passes on installed Chromium 149.0.7827.55, GPU disabled.
The retained checkpoint is redacted and the intentional worker exception is
observed separately. Online changelog comparison and package manifest checks
pass. Consumer checks verify both existing run and new worker exports.

## Canonical publication

Pushing main triggered the repository's existing trusted-publishing workflow,
run 40667603434 at e78168c. It staged 0.5.0 before the manual OTP attempt, which
returned E409. The extra user confirmation was unnecessary; future diagnostics
releases must use the existing trusted workflow rather than compete with it.
Registry SHA1/integrity now match the downloaded CI archive. Its 70 identical
files include every executable, declaration and package metadata file; eight
source maps differ only in mappings. CI uses its existing Bun 1.4.2 while local
checks use required BVM 1.4.4+absolute.1. No native payload is involved. Adopt
against the CI archive identity, not the different local tarball checksum.
