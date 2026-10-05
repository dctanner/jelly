# Browser file uploads

Use `browser_snapshot`, then `browser_upload` with the fresh `ref` for a visible
file input or the button that opens it, plus `paths` to the authorized local
files. Relative paths resolve from the agent's working directory.

Call `browser_upload` **instead of clicking the upload button first**. It arms a
short-lived file-chooser listener before clicking the exact referenced element.
This supports websites that hide their file inputs, without typing paths into
an OS file dialog. Ordinary `browser_click`, `browser_fill`, and `browser_type`
do not upload files.

Limits: 1–10 regular files, at most 50 MiB combined per tool call. This matches
Playwright's in-memory payload limit. Upload larger batches in separate calls
if the website allows it. Files above the limit need another supported upload
route; do not truncate them.

Files are read with bounded, cancellable reads into immutable buffers. The
browser receives the original basenames and inferred MIME types, not host
paths. Buffer-backed file objects remain readable if the source changes after
selection; temporary files must not be deleted immediately after path-based
`setInputFiles`, because websites may read their contents later.

References remain session-local and expire on navigation, tab changes, new
snapshots, cancellation, and handoff. Visible menu items are exposed as exact
snapshot references too, so upload actions in menus do not require an OS picker
workaround.

Some sites create a transient file input and remove it immediately after opening
the chooser. Chooser-based uploads keep that exact chooser-owned node and may
set its files after detachment; they never retarget a replacement. Direct file
input references still require attachment. File-input type, disabled/directory
and multiple-file checks, page ownership, cancellation and handoff guards remain
enforced. Uploads use the normal browser action
queue and ownership guards. The chooser interceptor is removed on success,
failure, timeout, abort, or handoff; it is never left installed during private
human control. An already-started upload cannot be unsent.

Only upload files the user authorized for the destination. Never upload
credential files. A successful tool result confirms **file selection**, not
website acceptance, completed processing, or publication. Inspect the
website's progress and preview before saving or publishing.

Regression tests live in `tests/browser-tools.test.ts`; tool exposure is covered
by `tests/apply-patch-transport.test.ts`. Run `bun run check` before deployment.
