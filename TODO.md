# Development tasks

The single active development backlog. IDs stay stable when tasks move.
Use Now for at most one active task; Next for ready work; Later for ideas;
Blocked for work waiting on a named decision or dependency; Done for completed work.
Every task records completion criteria and verification. Done requires evidence.
Mention the task ID in implementation commits; record commit hashes when known.
Historical plans remain context: [project guide](README.md).

## Now

## Next

- [ ] REEL-002 Test database and API behavior with isolated fixtures
  Priority: P2
  Order: 22
  Context: Existing regression tests cover the sync UI with simulated responses.
  Done when: Temporary-database tests cover writes, errors, and API responses without using the live library.
  Verify: npm test; confirm test teardown removes temporary databases.

- [ ] REEL-001 Show individual metadata-sync failures
  Priority: P2
  Order: 21
  Context: The sync control and overall feedback are fixed. Partial failures still need actionable per-show detail.
  Done when: Failed shows are named, errors are understandable, and retry targets failures without losing successes.
  Verify: npm test; provider fixtures for partial success and retry.

## Later

- [ ] REEL-003 Define and test snapshot recovery
  Priority: P2
  Order: 23
  Context: App Manager can create SQLite snapshots; the restore procedure needs a verified workflow.
  Done when: A documented restore is demonstrated using a disposable database.
  Verify: Compare integrity and record counts before and after recovery.

## Blocked

## Done

- [x] REEL-007 Add cautious, reversible show removal
  Priority: P1
  Order: 1
  Context: User has two earlier Pantheon additions and cannot remove them. Removal should be generally hard to do. User explicitly chose to preserve watch history and remove only from the library.
  Done when: Every show, including title-only local entries, has a tucked-away management/removal action. A dialog identifies the exact entry, explains preserved history, and requires typing its exact title before explicit confirmation. Removed shows disappear from library, counts, queue, upcoming, and bulk sync; history and cached data remain intact. A removed-shows section provides restoration. Provider confirmation reuses removed identities without creating duplicates. Cancellation, invalid confirmation, and failures preserve data.
  Verify: Isolated API/database tests for typed confirmation, duplicate-title identity targeting, preserved history/cache/flags, exclusion from library/stats/upcoming/sync, restoration, and provider re-add. Browser tests for empty/populated show management, cancellation, disabled confirmation, keyboard removal, restore, error retry, and narrow layout. Restart managed app and verify availability without removing real shows.
  Notes: No dependencies. Implement soft removal with persistent tombstones; no permanent-delete option and no automatic removal of the user's Pantheon records.
  Evidence: 2026-10-12: node --check passed for server.mjs and public/app.js; npm test passed 17 tests including 5 new isolated removal tests, and npm run test:browser passed 5 Chromium tests including 2 new removal tests at 1280px/390px. Verified exact-title server/UI guards, one-of-two duplicate targeting, cancellation, retained watch events/cache/flags, persisted tombstones, exclusion from stats/queue/upcoming/sync/new watches, provider re-add without duplication, removal/restore error retries, restored progress, and safe removed-route navigation. Fixture removal dialogs visually reviewed. Restarted ReelTime through App Manager; it reported healthy, and live dashboard/removed-shows endpoints returned HTTP 200. In the existing Chrome tab an older title-only Pantheon entry displayed collapsed Manage show and the removal action after expansion. No real show was removed/restored/added during verification. PROJECT_BRIEF.md and README.md updated. Tests use disposable databases and mocked providers; private-library integrity and live removal/restore writes were not separately verified.

- [x] REEL-006 Search and confirm show matches before adding and syncing
  Priority: P1
  Order: 1
  Context: User reports that Add show accepts a typed name and creates an empty show without useful discovery or reliable metadata synchronization. Replace this flow with provider search, clear match previews, and explicit confirmation.
  Done when: Typing a show name searches the available metadata provider and displays up to the best three ranked matches, each with title, thumbnail or fallback, season count, and episode count. Unknown counts are labeled rather than shown as zero; identifying details distinguish similarly named shows. Searching has useful loading, no-results, and error feedback; stale responses never replace newer results. A user selects and confirms a match before anything is added. Confirmation adds the selected provider identity and automatically syncs its show, seasons, and episodes into the local database. Duplicate selections do not create duplicate shows; failures remain understandable and retryable without leaving silently empty shows or losing existing data.
  Verify: Isolated provider/API and database tests for ranked matches, missing artwork/counts, no results, failed requests, stale searches, duplicate confirmation, and partial or failed sync with retry. Browser tests for typing, inspecting three match cards, explicit confirmation, automatic sync feedback, and the resulting populated show. Verify keyboard access and narrow-screen layout. Read and update PROJECT_BRIEF.md if this flow changes documented behavior.
  Notes: Launched 2026-10-11; no dependencies. Checked TheTVDB v4 schema: search has no reliable aggregate counts, so previews load the full paginated default guide and default-order seasons, excluding specials. Confirmation atomically saves provider identity, metadata, seasons, and episodes; empty guides are rejected. Existing title-only shows are preserved without guessed identities. Playwright is a pinned development-only dependency; production has no npm runtime dependencies.
  Evidence: 2026-10-11: node --check passed for server.mjs, public/app.js, and public/show-search.js; npm test passed 12 tests (8 isolated provider/API/SQLite tests plus 4 existing UI regressions). API tests cover ranked top-three matches, missing artwork/counts, no results, provider/series/page/malformed/empty-guide failures, automatic show/season/episode persistence, concurrent/repeated and imported-identity confirmation, failed refresh preserving watches, transaction rollback and retry; teardown asserts fixture directories are removed. npm run test:browser passed 3 Chromium tests at 1280px and 390px covering typing, three cards, missing/broken artwork fallback, keyboard selection/confirmation, explicit no-write-before-confirmation, sync feedback/populated page, loading/no-results/error/unknown-count feedback, retry, stale responses/reopened modal, cancel, and dialog overflow. Desktop and mobile screenshots visually reviewed. npm ci --ignore-scripts passed; PROJECT_BRIEF.md and README.md updated. Tests needed approved loopback/browser sandbox escalation; all provider responses were fixtures and browser remote requests were blocked. No live TheTVDB/CDN, private database/export, archive rebuild or snapshot/recovery was exercised; private-data startup/migrations remain unverified.
  Follow-up: Reopened 2026-10-12 after search failed in the running app. GET /api/shows/search returned 404 from the older server process. Verify App Manager restart, live read-only provider search, and browser result cards before closing; preserve private watch data.
  Follow-up evidence: 2026-10-12: running server returned HTTP 404 for GET /api/shows/search?q=The%20Bear despite the endpoint existing in committed source (882bca7). Restarted only ReelTime with python3 ../../appmanager.py restart reeltime; App Manager reported healthy. The same live read-only request then returned HTTP 200 with three ranked provider matches and populated season/episode counts. Observed the existing Chrome Add Show dialog displaying three live pantheon matches, including Pantheon (2022), 2 seasons / 16 episodes. No show was confirmed or added during this check. The previous fixture tests were not rerun for this documentation-only follow-up. Live provider search and browser results are now verified; private data integrity, live confirmation writes, CDN/calendar behavior, and snapshot/recovery were not separately verified.
  Commit: 882bca7 (implementation)


- [x] REEL-005 Write and verify the project brief for incoming agents
  Priority: P2
  Order: 1
  Context: New Codex sessions receive a task snapshot but lack project orientation, recent decisions, user preferences, and awareness of other work. Inspect this project and produce its own concise, durable handoff document; do not assume undocumented history.
  Done when: A root PROJECT_BRIEF.md explains the app purpose, supported entry points, how to run it, architecture and internal/external dependencies, data locations and persistence or backup behavior, development and verification commands, current work, and known pitfalls. Record established user preferences and decisions with references; explicitly label uncertainties. Link the canonical TODO.md and AGENTS.md rather than duplicating the backlog. Include a last-verified date and maintenance instructions. Add an AGENTS.md instruction to read and maintain the brief so incoming agents discover it.
  Verify: Check commands, paths, entry points, architecture, dependency ownership, and data claims against current code and configuration. Review planning documents and the current Git state. Ensure references resolve, exclude secrets and personal data, and identify anything that could not be verified. Confirm the brief is concise enough to orient a new agent.
  Notes: Documentation task only: inspect the project before writing. Do not invent user preferences or undocumented decisions. At completion follow the standing agent policy: verify, commit only assignment-related changes with the task ID, and push to the configured upstream; report blockers.
  Evidence: 2026-10-11: reviewed README/archive guide, Git history/status, server/UI/importer code, package scripts, ignore rules, and external App Manager registry/dashboard/snapshot implementation. All 13 brief references resolve; 818-word brief reviewed for orientation, task criteria, and absence of secrets/personal records. node --check server.mjs and node --check public/app.js passed; npm test passed all 4 simulated UI sync tests. No live server, private database/export, provider/CDN, archive rebuild, or snapshot/recovery operation was exercised; runtime limits are explicit in the brief.

- [x] REEL-004 Fix metadata-sync controls and feedback
  Priority: P2
  Order: 24
  Context: Controls used empty data attributes; completion now distinguishes success and partial failures.
  Done when: Controls dispatch requests and present pending, success, and failure states.
  Verify: npm test
  Evidence: 4 UI regression tests passed on 2026-09-30 using simulated provider responses; live provider acceptance was not performed.
  Commit: f2267c7
