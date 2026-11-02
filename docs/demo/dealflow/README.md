# Dealflow demo

The run behind the site's 60-second homepage demo: an agent writing a
listen-fire automation over MCP, the checker refusing a stage Attio doesn't
have, a one-token fix, and the saved automation then running on a real email.
The run includes one small extraction call. The fakes stand in for Gmail,
Attio and Slack.

How to record it is in `../README.md`; its data build writes
`listen-fire-site/video/dealflow/data.js`.

## What is in it

- `programs/draft.mvt`: the agent's first draft, the site's own program
  (`src/content/programs/founder_intake.draft.mvt`). It uses the user's word
  "Sourcing", which isn't one of Attio's stages, so `saveAutomation` refuses
  it with `MOV_ENUM_UNKNOWN_VALUE`.
- `programs/fixed.mvt`: the one-token fix ("Sourced"), which saves and goes live.
- `programs/founder_email.txt`: the founder's email body.
- `acme_credentials.ts`: copies the dev loop's seeded Gmail, Attio and Slack
  credentials as `acme_mail`, `acme_main` and `acme_slack`, the names the
  site's program connects.
- `capture.sh`: provisions Gmail and Slack, makes the mailbox's `Dealflow`
  label, plays the agent, sends the email through the fake Gmail poll, and
  captures the run. A loop on other ports is reached through `API_BASE_URL`
  and `FAKE_CHANNELS_URL`.
- `build_data.cjs`: the captures into the video's `data.js`.
