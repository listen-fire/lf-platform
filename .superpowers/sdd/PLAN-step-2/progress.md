# SDD ledger — plan: /Users/henrystanford/src/listen-fire/.claude/worktrees/upbeat-jennings-493586/plans/access-controls-2026-11-06/PLAN-step-2.md

Spec: /Users/henrystanford/src/listen-fire/.claude/worktrees/upbeat-jennings-493586/plans/access-controls-2026-11-06/DESIGN.md
Worktree: /Users/henrystanford/src/lf-platform-access, branch access-controls-step-2, base 34b609b3 (origin/main, release 0.15.2).
Throwaway Postgres for this branch: container lf-access-pg, postgres://postgres:access@localhost:55440/postgres. Remove at the end.
Scope (Henry, 2026-11-09, "Yes, start building"): the tasks needing no listen-fire release: 2, 3, 4, 5, 6, 9, 12. Tasks 1, 7, 8, 10, 11 wait for step 1's release.

## Preflight scan

| Pair or task | Produces → consumes | Found |
|---|---|---|
| T2 → T3, T4, T5, T6 | `accessTo`, `readableIds`, `setStatement`, `Verb` | Consistent. |
| T3 ↔ T4 | the coverage test | T4 extends T3's test. Consistent. |
| T3 ↔ T5 | save and edit routes | A save's verb depends on whether it creates or overwrites, which only `runSave` knows. See ruling 1. |
| T3 ↔ T6 | `setAccess` route | T6 creates a route after T3's registry exists. See ruling 2. |
| T5 ↔ T6 | statements at a new save | T5 refuses a new save without statements; T6 threads them from each route. See ruling 3. |
| T6 ↔ T12 | tRPC `movement.save`, `addCredential` | T6 makes the web create flows fail until the dialogs exist. See ruling 4. |
| T6, T9 ↔ T8 | fire statements | Stored before the door enforces them. See ruling 5. |
| T2 | self | `accessTo`'s verb type excludes fire; `setStatement` takes all four. Consistent. |
| T3 | self | Test seeds statements naming another user, calls as a write member. Consistent. |
| T4 | self | Required audience parameter; run snapshot inside authoring takes the caller's audience. Consistent. |
| T5 | self | All checks before `upsertMovementRow`. Consistent. |
| T6 | self | Consistent. |
| T9 | self | Plan says its fire part waits for T8 before shipping. See ruling 5. |
| T12 | self | The Slack line in the fire panel needs T10. See ruling 4. |

Ruling 1: save, edit and upgrade routes register as exempt with the reason "decided per target in runSave (Task 5)"; T5 makes that true — the verb depends on create or overwrite, which only the save path knows — if wrong, a route could slip the registry, so T5's tests must cover all three routes.
Ruling 2: T6 registers `setAccess` through T3's `decides`, as write on the automation or use on the connection — consistent with T2's rule on who changes a statement — costs little if wrong.
Ruling 3: T5 takes statements as an input to the save and refuses a new automation without read, write and fire; T6 supplies them from each route — keeps the rule in one place — if wrong, the split costs a refactor.
Ruling 4: T12 is built in this run, after T6, without the Slack line (needs T10) — T6 alone would break the web app's create flows — costs a second UI pass when T10 lands.
Ruling 5: fire statements are stored (T6 at creation, T9 backfill) now, though the door enforces them only from T8; T9 runs whole — storing is harmless while today's gate still runs, and it lets new automations carry one from day one — if T8 reshapes fire statements, T9's backfill is rewritten.

## Tasks
Task 2: dispatched (base 34b609b3, implementer opus)
Task 2: implemented 92d29dea (DONE_WITH_CONCERNS); review dispatched (opus)
Ruling 6: write implies read in accessTo — the design's Write ("edit, delete, change its access") needs the text, and a writer who can't read is a statement nobody would mean — if wrong, a writer sees text the author wanted hidden; goes into Task 2's fix round.
Ruling 7: changing a connection's statement needs use AND write membership on the team (implementer's choice, kept) — a statement change is a write, and membership caps everything — costs nothing if wrong beyond a read member asking a writer.
Ruling 8: a thing with no statement admits nobody (fail closed, kept) — so Task 9's backfill must land before anything ships; nothing is pushed until the whole run is gated — if wrong, a gap in the backfill locks a team out of its own automation, caught by Task 9's test.
Note: the throwaway Postgres needed pgvector; the implementer copied it into lf-access-pg from the local pgvector/pgvector:pg16 image and created database lf_access_test for integration tests.
Task 2: review 1 — spec ❌, Important: write list can name only read members (permanent lockout); uppercase user id stored but never matches; plan-mandated positional args. Minor: creation judged by gating list, not whole thing; check-then-act outside lock; delete ignores team; domain/email shape unchecked; polish.
Ruling 9: a list that still admits someone is never handed on by the leaver hook (implementer's reading kept) — handing on would narrow access — costs nothing if wrong.
Ruling 10: the three functions take subject first plus an options object: accessTo(principal, { target, verb }), readableIds(principal, { thing, teamIds }), setStatement(principal, { target, verb, grantees }) — the repo's style rule; Task 3 builds call sites on them — costs a rename if wrong.
Ruling 11: the creation window is "the thing has no statements at all", per the ruling's letter (reviewer's spec item, Minor #1) — goes into the fix round — if wrong, nothing lost.
Task 2: minor (deferred): check-then-act in passOnWhatTheyHeld and setStatement outside the advisory lock.
Task 2: minor (deferred): replaceGrants deletes without team_id filter, unlike grantsOf.
Task 2: minor (deferred): domain and email values unchecked for shape; validate before Task 8 judges against them.
Task 2: minor (deferred): migration header blank lines; teamId cast without uuid check in membersAmong / writeMembersOf.
Task 2: fix round 1/5 (5 findings + demotion fixed; commits 92d29dea..86b8e859); re-review dispatched (sonnet)
Task 2: fix round 1 re-review — 6/6 addressed, no new breakage.
Task 2: complete (commits 34b609b3..86b8e859, review clean after 1 round)
Task 2: minor (deferred): grantAccess reads prior access without a row lock (pass-on idempotent, harmless); grantAccess has no last-admin guard (existing behaviour).
Ruling 12: creation states an automation's write list (a connection's use list) before any other — mayChange closes the creation window once any list exists — carried into Task 6's dispatch; if missed, a creator locks themselves out, so Task 6 needs a test of the order.
Ruling 13: until Task 9's backfill, things without statements admit nobody, so test fixtures that create automations or connections directly also seed Task 9's defaults (read and write team, fire anyone, use team) — keeps existing tests meaningful without weakening the rule — if wrong, tests pass on fixtures that production won't have before Task 9; Task 9's own test closes that.
Task 3: dispatched (base 86b8e859, implementer opus)
Task 3: implemented, staged not committed (signing agent fails: 'communication with agent failed?'); review dispatched on the staged diff (opus)
Task 3: committed 3a3fdb01 after Henry approved signing in 1Password (staged diff under review is the same content)
Task 3: review 1 — spec ❌. Critical: settled engine questions fall back to team-only (no owner recorded; wait row deleted). Important: REST /v1/asks has no decision and isn't walked; coverage test can't tell write from read guard, doesn't assert side effects skipped, skips nested routers; untraceable runs decided by team alone.
Ruling 14: questions record their owning run and automation when asked (the platform's engine host writes it); an already settled engine question with no recorded owner fails closed — every question an automation asks belongs to it; costs: old settled questions vanish from the control tower for everyone.
Ruling 15: showDeliveryRequest needs read on every automation whose listen the delivery reached, as well as team admin — the raw request is more sensitive than the arrival summary that already needs read — costs an admin seeing less than before.
Ruling 16: a run whose automation can't be traced fails closed; a listen with no movement and a question a REST caller asked stay team-only (reviewer's verdicts accepted) — every run comes from an automation — costs: an odd run shape is hidden until the lookup learns it.
Ruling 17: createAutomation, teamHasContent and the public inbox routes stay exempt (reviewer accepted).
Task 3: minor (deferred): onRecentActivity decides once at subscribe; per-tick lookup uncached (measure on a busy team).
Task 3: minor (deferred): movement.list usedBy and credentialDependents counts include unreadable automations (Tasks 4 and 5).
Task 3: fix round 1 dispatched to a fresh implementer (opus), per token rule: fresh agents for fix rounds.
Task 3: fix round 1 implemented 06fd585e; re-review dispatched (sonnet)
Task 3: fix round 1 re-review — 7/7 addressed, no new Critical or Important.
Task 3: complete (commits 86b8e859..06fd585e, review clean after 1 round)
Task 3: minor (deferred): readableAsksForTeam doubles its fetch window (bounded); tRPC read assertions only check "differs from missing"; a column marking "asked by a run" would end the reliance on provenance keys; home dashboard run counts per listen.
Ruling 18: Task 4 extends the coverage test to walk the whole REST mount root, requiring every router to be listed or exempted with a reason (story, files, callbacks, connect, lfSecrets, knowledge, system included) — the design's top risk is a missed route — costs a larger Task 4.
Task 4: dispatched (base 06fd585e, implementer opus)
Task 4: first implementer stopped near 250k context, partial and uncommitted (catalog filter done and tested; coverage test red: connection route calls and a may-use pass missing; root walk of ruling 18 not started).
Ruling 19: language upgrades use the run audience — the design says a safe-rewrite upgrade needs write alone and adds no power — costs: an upgrade's diagnostics may name a connection the upgrader can't use.
Ruling 20: the story view uses the run audience behind read on the automation — its readers already see the text that names the connections — costs the same as ruling 19.
Ruling 21: a connect link refused because its name is taken by a connection the caller can't use stays as is — it reveals that a name exists, never what's in it; names are unique per team — costs a name leak.
Task 4: continuation dispatched to a fresh implementer (opus) on the uncommitted tree.
Task 4: implemented e431207d (continuation; signing approved). connectTelegramTeam and upsertFromManifest now decided by use.
Ruling 22: lf's secrets door use decision (held patch task-4-lf-secrets-held.patch) lands in Task 6, once lf-created secrets get statements at creation (no person → team use) — laying it now breaks lf reading back its own secrets — costs: until Task 6, any key with the secrets scope reads every connection's secret, as today.
Ruling 23: system routes (tg-runs, system adapter) stay exempt — the design says the system caller contract is unaffected — costs: a system-scoped key reads a team's runs, as today.
Task 4: minor (deferred): server.ts mounts checked against its text, not walked; a remote module install's own secret still serves author-time describes.
Task 4: review dispatched (opus)
Task 4: review 1 — spec ❌. Important: getAutomationDetail lists hidden connections; setTriggerCredential and createAutomation attach a connection with no use decision; Telegram connect link reuses a hidden connection; a remote module's install secret serves author-time reads whoever asks. Minor: graph explorer picks newest before filtering; re-save without use drops listen connections (Task 5); remoteAdapter.get shows hidden id; getAll filters twice; adapters.list counts hidden; server mounts by text.
Ruling 24: a remote module's install connection is a connection: author-time describe, introspection and graph walk through it need use; otherwise they answer as the catalog does (needs-secret) — the design's stated risk is exactly a describe reading through a connection the caller can't use — costs: authors without use can't explore that module.
Ruling 25: adapters.list's connectedCount may count hidden connections (counts only, team catalog) — costs a count leak.
Task 4: minor (deferred): server.ts mounts checked against text. Task 5 must land before the ship gate (re-save drops listen connections).
Task 4: fix round 1 dispatched to a fresh implementer (sonnet)
Task 4: fix round 1 implemented 84d1af0f; re-review dispatched (sonnet)
Task 4: minor (deferred): packages/trpc/types.ts hand-edited for `bound`; run `pnpm -r codegen:trpc` at the gate. A person's test run reads a remote module through its install secret; a call naming another provider credential isn't asked about the install secret.
Task 4: fix round 1 re-review — 7/7 addressed, no new Critical or Important.
Task 4: complete (commits 06fd585e..84d1af0f, review clean after 1 round)
Ruling 26: when a call names a provider credential other than the remote module's install row, the install secret may sign it and only the provider credential's use is checked — the data flows through the provider credential, and multi-user modules keep working for members without the admin's install secret — costs: the install secret's holder can't keep other members off the module entirely.
Task 4: minor (deferred): test_run.ts (a person's dry run) reads a remote module through its install secret; upsertFromManifest can no longer clear an install's secret by omission (stale web comment); per-read guard cost; masked-secret helper text.
Task 5: dispatched (base 84d1af0f, implementer opus)
Task 5: implemented 234b702f (DONE_WITH_CONCERNS); review dispatched (opus)
Ruling 27: a save naming a connection that doesn't exist is refused exactly like a hidden one (kept as built) — otherwise a saver could name a connection before someone else creates it and gain it at run time, since runs resolve connections by name — costs: an author can't save a draft before connecting; Henry to hear it.
Ruling 28: the lf-engine-team fire refusal (global constraint) is built in Task 6, where statements are set — carried into its dispatch.
Ruling 29: creations with no person (run audience: team migration import, dev scripts) get Task 6's whole-team defaults — carried into Task 6.
Task 5: minor (deferred): a rename by id into a name already taken; web app not type-checked against regenerated tRPC types (gate).
Task 5: review 1 — spec ❌. Important: REST/MCP save by id validates a hidden row before deciding (leaks existence and pin); upgrade's hold path names unseen group members. Minor: check/insert race (a deleted row is recreated with no statements; a run's save in between hands a person a statement-less row); refusal names a connection inside an unreadable library; statements on an overwrite dropped silently; duplicate empty-list check; unit test mocks the transaction; inner transaction gets a new request id.
Ruling 30: the check/insert race is fixed now (the decided row's id or an explicit create intent passed into the upsert) — a statement-less automation admits nobody, an outage for its team — costs a store.ts change.
Ruling 31: a refusal naming a connection inside a file the saver can't read names only that file, not the connection — the saver knows the file's name from its own import, not what's inside — costs a less specific message.
Ruling 32: statements given on an overwrite are refused, pointing at setAccess — an agent must not believe it set access — costs nothing.
Task 5: minor (deferred): unit test mocks inOneTransaction (integration test carries the proof); inner transaction gets a new request id in the audit trail.
Task 5: fix round 1 dispatched to a fresh implementer (sonnet)
Task 5: fix round 1 implemented 52459205; re-review dispatched (sonnet)
Task 5: fix round 1 re-review — 6/6 addressed, no new Critical or Important.
Task 5: complete (commits 84d1af0f..52459205, review clean after 1 round)
Task 5: minor (deferred): stale comment provision.ts:1598; no test of empty-list ordering; a 23505 inside a caller's open transaction would abort it (unreachable today); a run passing statements on overwrite is ignored silently.
Ruling 33: triggers.createAutomation needs no statement — it creates a listen with no movement, no automation thing exists (Task 3's reviewer accepted it team-only) — costs nothing.
Ruling 34: one shared function gives the defaults for a creation with no person (automation: read and write team, fire by its listens' modules per Task 9; connection: use team); Task 6 builds it, Task 9 reuses it — one rule, not two — costs nothing.
Ruling 35: setAccess validates domain, address and phone shapes (Task 2's deferred minor) — it's the boundary — costs nothing.
Task 6: dispatched (base 52459205, implementer opus)
Task 6: implemented, staged not committed (signing refused; Henry away); review dispatched on the staged diff (opus)
Ruling 36: a file with no listens gets fire for the team by default; a WhatsApp number of its own gets anyone (implementer's reading of ruling 34, kept) — fire matters only with listens, and an own-number WhatsApp routes by connection — costs nothing until Task 8 enforces.
Task 6: review 1 — spec ❌. Important: raw-insert connection creations (testHarness.seedFakeCredentials, ~15 dev-loop and UI-test seeds) state nothing and admit nobody; test gaps (pre-statement connect landing, key-entry and OAuth mint, setAccess body and refusals over the route, REST/MCP save forwarding statements). Minor: setAccess answers a read-only member 400 on a connection vs 403 on an automation; connection lookup in default team only; a run's partial statements dropped silently; import writes statement rows directly; landing doesn't recheck the minter; misleading page in a deleted-Telegram race; reconnect through a link resets use and orphans statements.
Ruling 37: a run's save given one or two of the three lists is refused as a programming error — silent degradation is the absence of a guarantee — costs nothing.
Ruling 38: the import's direct statement-row insert stays — it needs the import's transaction and writes constant lists — costs a second writer of the table.
Task 6: minor (deferred): the landing doesn't recheck the minter's standing within the link's lifetime; reconnect through a link resets use and orphans statements (final review to triage).
Task 6: fix round 1 dispatched to a fresh implementer (sonnet), building on the staged Task 6 work; commits Task 6 then the fix.
Task 6: fix round 1 done in the working tree (unstaged, on the staged Task 6 work); both commits blocked by signing; re-review dispatched (sonnet)
Task 6: fix round 1 re-review — 6/6 addressed, no new breakage.
Task 6: complete in review (base 52459205; Task 6 staged, fix unstaged on top; commits blocked by signing — Henry away). Next on approval: git commit -F task-6-commit-message.txt; git add -A (excluding .superpowers); git commit -F task-6-fix-commit-message.txt. Then Task 9.
Task 6: minor (deferred): guard test sees only literal insertInto calls; dev scripts not run against a real database; MCP save test checks schema and endpoint only; lint import order.
Task 6: complete (655aea5e feature, 57937ee9 fix; review 6/6 addressed)
Ruling 39: Task 9 builds and tests the backfill and the listing script; the check of Project A's live team runs at deploy time, before the backfill is applied, not now — it needs production access, and it gates applying, not building — costs nothing if done at deploy; listed in the report to Henry.
Ruling 40: the backfill takes its rule from no_person.ts (automationWithNoPerson, connectionWithNoPerson), not a second copy in SQL — one rule (Ruling 34) — costs a TypeScript step in the deploy if the platform's migrations are SQL only.
Task 9: dispatched (base 57937ee9, implementer sonnet)
Ruling 41: "Only you can see this" shows wherever a thing admits only the viewer (automation read list = just them; connection use list = just them): on its access panel and its list row — the plan names the phrase without placing it — costs a moved label.
Ruling 42: Task 12's screenshots run on the agent dev loop profile under its own compose project and ports (LISTEN_FIRE_STACK=listenfire-access-ui, Postgres 9436, Redis 6383, S3 9014), with an untracked apps/api/.env built from the committed .env.example plus throwaway values — the running listen-fire-dev-agent containers belong to another session, the default profile shares the developer's database, and the main checkout's .env may hold real keys — costs a first-boot schema apply.
Ruling 43: the Slack line in the fire panel is left out (waits for Task 8, plan line 18); the fire panel is built — costs nothing.
Ruling 44: the web reads and sets statements through two new tRPC procedures (views.access.get, views.access.set) over the same decide.ts functions the REST setAccess uses, registered in the decision registry — no tRPC read exists today — costs two procedures.
Note: the OAuth ConnectUrl procedures create nothing (tokens go to pending storage); the web claims them through addCredential, which already requires use — no gap.
Task 9: implemented e23cc9e1 (DONE_WITH_CONCERNS: backfill is a deploy script, not SQL; old replica during rollout can create unstated things); review dispatched (opus)
Task 12: dispatched (base e23cc9e1, implementer opus), while Task 9's review runs (reads only)
Task 9: review 1 — spec ✅ in substance; Needs fixes. Important: backfill reads listens from trigger rows (can miss listens of an automation stopped at an upgrade → can widen fire); README's operator steps can't run before the deploy that creates the table. Minor: rollout window on the first deploy (old replica creates unstated things); migrate line lacks || exit 1; later runs state things silently; NOT EXISTS race if a creation isn't one transaction; no WhatsApp case in the backfill test.
Ruling 45: the backfill derives a file's listens from its source, through the same function the save path uses (listenReachesOf) — one derivation of "a file's listens", and the source is the truth — costs a parse per automation per deploy (no-op after the first).
Ruling 46: up.sh re-runs the backfill once after the api is healthy, and the Render guide says to run it once by hand after the first deploy carrying this — closes the first-deploy rollout window — costs one line each.
Ruling 47: a run that states anything logs each thing's id, and warns when it is not the first run (nothing unstated should exist after it) — fail closed must not be papered over silently — costs nothing.
Task 9: fix round 1 queued until Task 12's implementer finishes (one writer on the branch at a time).
Task 12: implemented 870d4f02 (API read/set procedures), f5b0b7d6 (web) (DONE_WITH_CONCERNS); screenshots in screens/; review dispatched (opus)
Ruling 48: the new-automation page saves with a create intent: a taken name is refused as name_taken ("an automation called X already exists; pick another name"), never treated as an overwrite; and no refusal a person sees on the web names an agent tool (setAccess) — Task 5's explicit intent was for exactly this — costs a small fix in Task 12's fix round.
Ruling 49: "Only you can see this" never counts a whole-team grant, even on a team of one (implementer's reading of Ruling 41, kept) — whoever joins next sees it — costs nothing.
Task 9: fix round 1 dispatched to a fresh implementer (sonnet), base f5b0b7d6
Task 12: note for fix round — retake screen 3 (the editor behind the dialog shows the code typed as one line with literal 
, so a parse error shows)
Task 12: review 1 — Needs fixes. Important: Ruling 48 confirmed (new page saves without create intent; setAccess text reaches a person); Telegram asks a question that can't succeed and shows setAccess text, matched by text; a refused creation choice can't be changed without reloading. Minor: `as UserId`; names without on-team check; product_gate claim; hand-copied SaveRefusal; silent panel load failure; mixed team+names list comment; test gaps (statements only on creation, addCredential carries use, connect action passes list).
Ruling 50: the access router's product_gate claim (automations) stays, with a why comment — automations owns both things — costs a line if the plans later split it.
Ruling 51: on a team that runs on the lf engine, the creation dialog offers only "Anyone who reaches it" for fire — the server refuses anything else there — costs nothing.
Ruling 52: the web never shows server refusal text to a person; each kind gets the web's own sentence, and the statement refusal gains a code for it; the server's agent text stays — costs a code field.
Task 12: fix round 1 written (task-12-fix-1.md); queued until Task 9's fix commits.
Task 9: fix round 1 implemented 120b0625; re-review dispatched (sonnet)
Task 12: fix round 1 dispatched to a fresh implementer (sonnet), base 120b0625
Task 9: fix round 1 re-review — 7/7 addressed, no new Critical or Important.
Task 9: complete (commits e23cc9e1, 120b0625; review clean after 1 round)
Task 9: minor (deferred, FINAL REVIEW MUST TRIAGE — both can widen fire): (a) an unparseable source goes through listenReachesOf's lexical fallback, which misses a Slack construction in a one-line body, a callee on the next line, or a multi-line aliased import — fail closed on MovementParseError instead; (b) listenReachesOf walks assign/movement/block/if only, skipping handle/match/until, so a Slack listen nested there is missed — same on the save path. Also: render.md:71 manual path omits the statements step; fail-closed test mocks the throw.
Task 12: fix round 1 implemented 0cc1f742; re-review dispatched (sonnet)
Ruling 53: the Telegram connect's three refusals become a returned result ({ok:false, reason}) rather than borrowed tRPC error codes (PRECONDITION_FAILED / CONFLICT / UNPROCESSABLE_CONTENT) — a code chosen for its distinctness, not its meaning, is a magic mapping — goes to the final fix wave — costs a small change.
Task 12: carried to final fix wave — Ruling 52 also covers the Access panel's refused set (shows err.message) and the panel's Fire editor on an lf team (offer only Anyone); Telegram "not configured" still matched by text.
Task 12: fix round 1 re-review — all addressed, no new Critical or Important.
Task 12: complete (commits 870d4f02, f5b0b7d6, 0cc1f742; review clean after 1 round)
Task 12: minor (deferred): creation dialog shows "Loading the team…" forever if teamEngine.get fails; a tRPC error on save doesn't clear the stored choice; the panel editor keeps a departed person's id (refused as not_a_member, shows server text — Ruling 52 panel gap).
Final review: dispatched (base 34b609b3 = merge-base with origin/main, head 0cc1f742, fable)
Final review: With fixes — Critical 1 (save rule's statement walk not exhaustive: closures/await arms), Important 5 (admin membership paths skip pass-on; lexical fallback widens backfill; reconnect resets use list; movement-less listen's runs nobody's; panel server text). Full text final-review.md.
Ruling 54: a run of a listen with no automation is the team's, as the listen is (Rulings 16+33 reconciled) — costs: such runs show to the whole team.
Ruling 55: M2-M4 (subscription query cost, home empty verdict, warning reader cache) are left — performance/wording, not access — recorded for later.
Ruling 22 stays (lf-created secrets get whole-team use even under a person's key: lf has no way to say otherwise yet); flagged to Henry as worth his eye.
Final fix wave: dispatched (one implementer, opus), base 0cc1f742; brief final-fix-wave.md
Final fix wave: implemented, staged not committed (signing refused; Henry away). One combined message in final-fix-commit-combined.txt. Re-review dispatched on the staged diff (sonnet).
Ship gate: started on the staged tree (script scratchpad/platform-gate.sh; legs sequential)
Final fix wave: re-review — 11/13 addressed; I2 partial (strict parse ignores each file's language pin), M6 partial (team_id in the grant key refuses nothing).
Ruling 56: the backfill parses each file under its own pin (movement.language_version); a pin legacy-lang can't read gives the team — narrowing must also not be silent — costs a small change; done after the gate run, then the affected legs re-run.
Ruling 57: revert M6's key change (keep the migration's reuses_connection column) — it refuses nothing and is slightly looser; readers already filter by team, so a mis-teamed row fails closed — costs nothing.
Ruling 58: an AST kind the walk doesn't know throws loudly (fails a save or an editor schema read) rather than degrading — safe direction, only reachable from a parser the types don't describe — left as is.
Ship gate run 1 (staged wave): smoke 93/93, conformance v1 and v2, web 301/301, prisma client, tRPC codegen (no diff), audit triggers — pass. Typecheck: only the 4 known errors (optional packages files-s3, ocr-google not installed); recursive run stopped at api, rest to re-run with --no-bail. api unit 8345 passed, 1 failed (seam_guard: run_writes.ts unclassified — real). Integration chunk: door_pool_budget fails on lf_access_test but passes 42/42 on a fresh DB (leftover rows, not the branch); file_ownership_backfill needs files-s3 (environment). legacy-lang/engine legs didn't start (flag) — re-run.
Final fix round 2 dispatched (sonnet): Ruling 56 pin, Ruling 57 revert key, seam guard.
Final fix round 2: done (staged). Migration renamed to 20261110_174400_connect-token-reuses-connection.sql; combined commit message updated. Gate run 2 started.
Ship gate run 2 (staged wave + round 2): typecheck — every package clean except apps/api's 4 known errors (optional packages files-s3, ocr-google not installed here); tRPC codegen and prisma client unchanged; api unit 8346/8346 (511 suites); legacy-lang 4962, legacy-engine 342, conformance v1 and v2, web 301, audit triggers — pass. Integration chunk: 23 suites failed on one shared database, all "too many clients" or a seeded currency row colliding; re-run one worker at a time, 17 of 21 passed, and the remaining valuations suites pass on a brand new database (9/9); the branch touches valuations only to register an exemption. file_ownership_backfill needs files-s3 (environment).
Ship gate: GREEN apart from this machine's environment. Final commit blocked by signing (Henry away); staged, message final-fix-commit-combined.txt.
Overview for Henry published: https://claude.ai/artifact/KqAUdu8gm6uPyXFQYYrWAP (source scratchpad/overview/index.html in the listen-fire session)
- Final fix wave committed: 1150c687 (2026-11-11)
- Picker polish (Henry 2026-11-11: "a drop-down with progressive disclosure"; wrapping) committed eb58c966. Screens in screens/polish/.
  Ruling 59: on an lf-engine team, fire's single answer ("Anyone who reaches it") is set by the component itself, the one exception to nothing preselected — it is the only legal answer, so a choice there would be a click with no decision — costs: a person never confirms it explicitly.
  Ruling 60: "reads only" sits outside the truncation, the address gives way — the access level matters more than the address tail — costs nothing.
- MCP gap found: no read of the lists. Ruling 61: lists go on getAutomation and describeConnection, no new tool — fewer tools cost fewer tokens per session and an agent reads those before editing anyway — costs: an agent wanting only the lists pays for the program text. Dispatched (sonnet), brief mcp-read-brief.md.
- MCP read committed eb58c966; onTeam:false guidance added to setAccess description.
- MCP read STAGED (signing failed while Henry away); commit with: git commit -F .superpowers/sdd/PLAN-step-2/mcp-read-commit.txt
- MCP read committed a19b3e31
- Admin role built (opus), uncommitted; report admin-report.md. Fix round 1 dispatched (sonnet): wire_keys mock (my a19b3e31 regression) + Ruling 62.
  Ruling 62: engine switch, public inbox claim/release and reading a kept request need admin — each is a team setting or opens the team to strangers, and the kept-request ruling meant admins when admin meant write — costs: write members who did these today lose them until promoted (none, since write members become admins at migration).
  Ruling 63: an invite carries no level; invitees join as write and an admin promotes — invites predate levels beyond read/write — costs: one extra step to add an admin.
  Ruling 64: the admin log line names actor and thing, not list contents (fire lists hold emails and phones; audit_log has them) — costs nothing.
- listen-fire 0.15.3 released 2026-11-11 (main c7c342b2fd; crates + npm verified; module-wire 0.12.10).
Task 1: complete 2d6e1c5d (module-kit bumped across workspace, ruling 65: one copy of module-kit)
- Admin review (opus): 0 critical, 3 important, 6 minor (admin-review.md). Fix round 2 (sonnet) done; scoped re-review (sonnet) dispatched.
  Ruling 66: a locked thing over MCP/REST carries its lists, as the design says, so an agent edits the list it read rather than replacing it with itself — costs: list contents visible to admins over MCP (they are anyway on the web).
  Ruling 67: the public identity stays write on new and upgraded installs — it is the anonymous sender behind public inboxes and manages nothing — costs nothing.
  Ruling 68: finding 6 (platform admin app's Grant bypasses the last admin guard) predates this change; left as a follow-up.
- Admin role STAGED (signing failed, Henry away); commit with: git commit -F .superpowers/sdd/PLAN-step-2/admin-commit.txt. Task 7 builds unstaged on top; commit the index first.
- Admin role committed 1f19593f
- Task 7 implemented (opus), uncommitted (DONE_WITH_CONCERNS); review dispatched (opus).
  Ruling 69: Actor's Id and Proven come from the arrival's own actor; only the address comes from the first originator — Slack's candidate carries no proven, and taking it whole would refuse every Slack member under Task 8; matches lf — costs nothing.
  Ruling 70: replaying a kept page rewrites Actor (pages predate Actor) — joins the stated replay deviation — costs: replay reads who acted as now, not as then.
- Task 7 review (opus): 0 critical, 4 important, 10 minor (task-7-review.md). Fix round 1 dispatched (fresh opus), brief task-7-fix-1.md.
  Ruling 71: "reads Actor" is a flag saved with the listen plan from the file's text, as lf does; plans saved before count as not reading it — field ids list every field, so the brief's test was always true — costs: one column on saved plans.
  Ruling 72: a wait's landing gets Actor when the waiting automation reads it — an approval button awaited by a manual automation must see who pressed it — costs: a lookup per such press.
  Ruling 73: withActors hands back its decision per arrival as a closed union; Task 8 judges only from that — a field keyed Actor may be the module's own or partial — costs nothing.
  Ruling 74 (flag to Henry): Member stays "the named address belongs to a member", true even unproven; only Proven says the system vouched; documented beside email's warning — Task 8's email exception needs it — costs: a filter on Member alone over email is spoofable, as Domain is.
- Task 7 fix round 1 done (719 unit, 4 integration suites). Decision union has five cases (adds nobody).
  Ruling 75: readsActor considers every imported file through the save rule's import walk; an unreadable import counts as reading Actor — silent absence is worse than a lookup — costs: a lookup for files whose imports cannot be read. Fix round 2 dispatched (sonnet).
  Ruling 76: the per delivery flag (one flagged listen makes every arrival on that connection look up) stays — per edge needs the plan's edges at the door; measure in the end to end cost check — costs: extra lookups on mixed connections.
  Ruling 77: M4, M6, M7 stay open as minor (replay test, a member lookup database failure fails the delivery, describe view) — none changes who may fire — costs: noted for the final review.
  Henry 2026-11-11 on Ruling 74: "Only when proven". Ruling 74 is replaced by Ruling 78: Actor.Member (and User, which names the same match) are set only when Proven is true; an unproven address that matches a member gives Member false and no User. The fire judgement for email's exception reads the match from withActors' decision, not from the author's fields — the exception stays possible without a spoofable Member — costs: a filter can no longer tell an unproven member's email apart from a stranger's through Member. Applied in fix round 3 after round 2 returns.
- Task 7 re-review (sonnet): I1, I3, R75, R78 resolved; I2 partly (a run started manually or by schedule never got readsActor). Fix round 4 (opus, escalated): readsActor stored once per automation, wait query reads it there.
Task 7: complete d19f461f (4 fix rounds; re-review I2 closed by round 4).
  Ruling 79: reads_actor is per automation, not per version — the brief named the automation; a run pinned to an older version that read Actor loses it only if the automation is re-saved without Actor mid-run — costs: that rare run sees no Actor.
  Ruling 80: an importer's flag goes stale when only an imported file is re-saved (importers are re-checked, not re-provisioned) — re-provisioning importers is its own change — costs: an import newly reading Actor needs its importer re-saved; noted for Henry.
- Task 8 implemented (opus), uncommitted, DONE_WITH_CONCERNS (851 unit, 36 integration suites). Review dispatched (opus) with focus on bypasses (carried pins), refused listing, fail-closed cases.
  Ruling 81: every replay and Run now skip the fire list — each needs write, and the writer vouches; replays record who replayed — costs: a writer can start any automation by hand, as today.
- Task 8 review (opus): spec NOT compliant; C1 carried pins never judged; I1 refused not listed; I2 every replay skips; I3 module own Actor refused without warning. Fix round 1 (fresh opus), brief task-8-fix-1.md.
  Ruling 82: carried pins (0.12, legacy 1-4) are judged by the fire list; the decision is computed without writing Actor into their landings — the fire list is the platform's, not the language's, so a pin does not exempt it; a pinned program must not see a change — costs: lookups on carried deliveries. Fallback if infeasible: report BLOCKED, do not build.
  Ruling 83: refused arrivals listed beside unjudged ones (listArrivals, web activity) — the plan's final check needs "listed", and a writer must find what to replay — costs: one more state in the list.
  Ruling 84 (narrows 81): only a replay of a refused arrival skips the fire list; any other replay is judged; Run now stays unjudged — costs nothing.
  Ruling 85: a module's own Actor is treated as "can't cover" (fires under any rule, save warns), as the design says for a module that reports nobody — costs: such a listen is not restricted, and the author is told.
- Task 8 fix round 1 (opus): I1, I2, I3, M1, M3, M6 done; C1 BLOCKED (carried receipts are 0.12 events; 0.12 modules never vouch). Verified on origin/main: pins 1-4 already start no new run (doorRefusal, since 6bd63737); only 0.12.13 pins run carried.
  Ruling 86 (replaces 82): carried pins take fire = anyone only, refused at write with the upgrade as remedy (sibling of lf_engine); backfill states anyone for them; Task 11 keeps the Slack actor gate for carried pins only — judging them would refuse every member, since nothing vouches — costs: a 0.12.13 automation can't narrow who fires until upgraded.
  Ruling 87: polls that report who acted are judged; only cron and system are exempt — a polled inbox has a sender — costs nothing.
  Ruling 88: arrival_refused, append-only facts like arrival_unjudged, takes no audit trigger — costs nothing.
  Fix round 2 dispatched (sonnet).
- Task 8 re-review (sonnet): commit. Edge cases left (unknown with an empty fire list refused; unknown on a module that reports nobody fires) — both follow stated rules.
  Ruling 89: a refused fact stays after a writer's replay ran it (the list shows Refused) and team_migration copies fire lists unchecked — minor; for the final review — costs: a stale badge; an imported carried automation keeps a narrow list the carried path ignores.
- Task 8 STAGED (signing failed, Henry away). Commit with: git commit -F .superpowers/sdd/PLAN-step-2/task-8-commit.txt. Task 10 builds unstaged on top.
- Task 10 implemented (sonnet), unstaged on top of staged Task 8; review dispatched (sonnet).
  Found: Task 1 regression — six module parity suites (email, whatsapp, telegram, granola, slack, attio) and one telegram unit test fail on 0.15.3's proven and Forwarded Through. To fix in Task 10's fix round.
  Ruling 90: remote modules get no settings until listen-fire's engine carries a settings slot for remote adapters — only Slack declares one, and it is built in — costs: a future remote module's setting is ignored; follow-up in listen-fire.
  Ruling 91: turning the line off writes "off" (not a removed key), so the default on cannot revive it; the web shows the line in both states with its toggle — costs nothing.
- Task 10 review (sonnet): 0 critical, 1 important (a Slack connection filled in place keeps no setting), 7 minor. Fix round 1 (sonnet) with I1, M1, M2, M6, M7 and the Task 1 parity regression (committed apart).
  Ruling 92: M3 (an unnamed connection's on/off state shows to someone without use), M4 (Slack delivers its own message when auth.test fails; loopDepth backs it), M5 (the audit trigger copies sealed ciphertext on the backfill and each toggle) stay — each is the automation's own behaviour or matches any credential edit — costs: noted for the final review.
Task 8: complete ab1635e6.
Task 1 parity regression fixed c9db40bf (Slack re-recorded: 0.15.3 asks users.info for the sender).
Task 10: complete 80b3e852 (its commit carries a Sonnet co-author line from the report; not amended).
Task 11: complete b29f553a (author note reworded at top level)
- Final review 2 (opus), 1150c687..b29f553a: 1 critical, 3 important, 6 minor (final-review-2.md). One fix dispatch (opus), brief final-fix-3.md.
  Ruling 93: an upgrade off a carried pin restates the fire list with the no-person default from the upgraded file's listens, and says so — the forced anyone was never chosen, and the gate it replaced stopped strangers — costs: a Slack automation becomes team only on upgrade until someone widens it.
  Ruling 94: an engine switch keeps lists and says the consequence both ways; the panel says "Not checked while this team runs on lf"; team import runs each fire list through checkedList — the switch is an admin's deliberate act, and rewriting chosen lists would be worse — costs: a switch back exposes "Anyone" lists, as stated in its confirmation.
  Ruling 95: one CHANGELOG entry for the whole change; UPGRADING corrected; drain stopped before the new api starts.
  Ruling 96: carriedPin and the lf engine fact reach MCP/REST; setAccess texts name exactly which automations refuse narrow fire lists.
  Ruling 97: M1, M3, M4 fixed; M5 (agents can't see Slack's setting) and M6 (the poll scanner reads every team's fire lists per scan) stay — neither changes who may fire — costs: noted for Henry.
- Final fix 3 re-review (sonnet): commit; deviations accepted (import applies only the fire rule; an upgrade keeps a list already lacking anyone; built-in-only listens give team; lf panel keeps the list with a line).
  Ruling 98: open, not blocking — an upgraded group's other members are restated silently (the answer names only the asked one); import's fire rule runs over every automation of the team; on an lf team an upgrade restates Slack to anyone (Ruling 94's warning covers it).
- Final fix 3 committed ab013ba8.
- Platform gate 3 (whole branch, full integration, maxWorkers=1, fresh db): typecheck only the 4 known; trpc codegen clean after commit (gate ran before it); legacy-lang, legacy-engine, conformance v1/v2, web 322, audit triggers pass. api unit 6 suites / 11 tests fail; integration mcp_host 1 test (+ file_ownership_backfill, needs files-s3). Fix-up round 1 dispatched (sonnet) with the log evidence only.
- Gate fix-up committed 11f1e33c (0.15.3 spelling in expectations; save test mock for the upgrade restatement).
- Gate run 4: api unit 519/519 suites (8565 tests); integration 137/141 — 3 failed on "too many clients" (machine), each passes alone on a fresh db (7/7); file_ownership_backfill needs files-s3 (absent here). Gate GREEN at 11f1e33c, with the files-s3 and ocr-google gaps.
- End-to-end checks dispatched (verifier), brief e2e-brief.md.
- End-to-end (verifier, opus): checks 1, 3, 4 (Slack path), 6, 7 PASS; 5 measured (door median 13.1 ms, +0.9 ms repeat sender, +2.1 ms new sender, against fake Slack); check 2 FAIL — a run reading m.Actor fails with a drift error (the checker sees the graft, the run time schema does not). Fix dispatched (opus, systematic debugging), brief actor-run-fix.md.
  Noted: read members cannot mint their own API key (core.api_key permission); the email exception was not exercised end to end; a writer who is not an admin was not covered (the migration made all writers admins).
- Actor run fix committed 69deaefa: the platform's run host answers Actor reads itself from what the door wrote (as lf's held_actor does); the catalog offers Actor only to the current pin.
  Ruling 99: legacy pins 1-4 lose the Actor offer Task 7 had grafted onto them — a pinned program must not change (Rulings 82/86) — costs: nothing a pinned program could read before Task 7.
  Check 2 rerun on the dev stack dispatched (verifier, sonnet).
- E2E check 2 PASS after 69deaefa. Overview v4 published (7 of 7). Branch HEAD 69deaefa, unpushed. Full gate must rerun before any push (69deaefa came after gate run 4).
- 2026-11-13 Henry: "Strip before pushing. Let's get this done properly monolithically." Nothing pushes until step 2 (minus the fire list) and step 3 (claims as branded types, host functions in listen filters, use on libraries, events replayable whole) ship together. Design v2 being drafted: listen-fire worktree plans/access-controls-2026-11-06/DESIGN-v2.md.
- 2026-11-13 DESIGN-v2 approved by Henry (listen-fire worktree plans/access-controls-2026-11-06/DESIGN-v2.md). Next: builder check, then a plan across both repos.

## Strip (v2)

- 2026-11-13 P6: branch HEAD after the strip is 31dc43b1 (fixture commit on a4419c99). Gate on the stripped branch, serial, throwaway Postgres (lf-access-pg, recreated fresh):
  - code:type-check (pnpm -r): only the 4 known errors (ocr-google, files-s3); engine and version boundary scripts clean.
  - codegen (kysely, prisma, tRPC): no semantic diff; kysely table order churns (import and union order only), reverted rather than committed.
  - apps/api test:unit: 516 suites; green with the database env set (the limiter suites need DATABASE_URL_TEST; every_route_decides failed once on a 1ms vs 2ms timing field under two workers, passed alone).
  - apps/api test:integration (one worker, fresh db): 134 of 135 suites pass, 1104 tests; file_ownership_backfill fails to load (files-s3 not installed, known).
  - conformance current/v1/v2/v3/v4: all pass. legacy-lang 177 suites pass. apps/web unit 34 suites pass. legacy-engine 26 suites pass. check_database_triggers.sh exit 0.
  - Not run: language:conformance and adapter:conformance (both need arguments: a checks.json and a --url); schema:compare (its script reaches a database on port 9436 from .env).
- Rulings the strip INVALIDATES (research C): 5; 11, 12; 13; 28; 34 and 36 (fire parts; 34's connection=team-use survives); 43, 51, 59, 60; 45, 56; 69 to 89 (Actor storage, readsActor, withActors, carried-pin fire, refused listing, replay skipping fire); 90, 91, 92 (module settings, drop_own_messages); 93; 94 (fire half); 96, 97; 99.

## v2 rulings

The controller's rulings 8 to 36 in the v2 plan ledger (`.superpowers/sdd/PLAN-v2/progress.md` in the listen-fire worktree) that touch this repository. Numbers are the v2 ledger's, not step 2's above. Ruling 38 is added because it post-dates the range and also lands here.

- 8: before the strip's gate, recreate the throwaway database fresh, run schema:apply and all:codegen, and diff against the hand edited generated types (P2).
- 9: `access_statement` keeps its `value` column (a user grant stores its user id); `value_check` becomes `(value IS NULL) = (grantee = 'team')` (P4).
- 13: F1 splits: F1a (lang-0.15 package, drop lang-0.12 and the TypeScript interpreter, run router into the api, 0.12 upgrades through legacy-lang dialect 5, deploy check) now; F1b after the 0.16 tarballs.
- 15: a wait's WHERE follows the listen's failure rule: an unreachable host leaves the arrival unjudged for that wait, the run stays parked, and the arrival is retried in order; a genuine plugin error result still fails the run (F4).
- 16: "why didn't this fire?" names the failed term spelled from the listen's plan (normalised), not the source text (F6b).
- 17: use on libraries (F5) runs before F1b to F4, since it needs nothing from 0.16.
- 18: a connection's page lists every library naming it, by name, to anyone who may see the connection; never the source without read.
- 19: a library whose named connection does not exist does not stand, which closes the create later route; its runs are refused until the connection is reconnected.
- 20: 0.16 diagnostics carry a structural field naming the file they came from; the platform hides library faults by that field instead of parsing messages (F2).
- 21: lf caps every cached host answer at min(the plugin's `maxAgeSeconds`, 300 s), because an invalidation reaches only the process that started the module.
- 22: signing is blocked, so work continues on staged trees recorded in the ledger; the controller later builds a signed chain with `git commit-tree -S`, one commit per task and fix.
- 23: no backfill of upgrade checks stored before F5 round 2 (use on libraries is new on this unpushed branch).
- 24: F6 splits: F6a (delivery shown by use on its connection, runWithEvent needs write with a vouched firing, replay reruns only that automation's listens) now; F6b ("why didn't this fire?") after F1b.
- 25: Slack's `drop_own_messages` is not rewritten in text; the platform's per connection setting and its switch are removed, and `NOT m.\`Sent By This App\`` replaces it (MOV_LISTEN_NOW_OPEN names it on upgrade).
- 26: the connection is recorded on a delivery when it is kept (`delivery.credentials_id`); seeing or running a delivery with a recorded connection needs use on it, and one with none keeps the old gate.
- 29: F1b splits: F1b-i takes the 0.16.0 tarballs and makes 0.16 current with nothing carried yet (0.15 pins held); F1b-ii carries 0.15 and the old Slack gate below 0.16 after Henry's answer. Nothing ships until F1b-ii lands.
- 31: the dotted call reading stays ungated in 0.16; the platform's three tests are updated.
- 32: legacy-lang's TypeScript checker reports an unknown root of a dotted call as MOV_NAME_UNRESOLVED with the import fix (a silent pass is not acceptable).
- 33: plugin declarations may declare typed record outputs, and `call(...)?.Field` is admitted in a listen filter and a wait's WHERE when the call is pure (listen-fire task L10), so the team's `userFor` can be used in a filter.
- 34: `isMember` and `userFor` require `granted_access_at` for every claim; the phone path's extra `verified_at` stands (F3).
- 36: a judged arrival that is waiting keeps its fact and landing: a `waiting` column and the kept order are accepted in place of a `host_unreachable` reason (F4).
- 38: an explanation of "why didn't this fire?" bypasses the host answer cache and writes nothing back (F6b fix round).
