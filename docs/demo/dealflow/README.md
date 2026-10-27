# Dealflow demo

The run behind the site's 60-second homepage demo: an agent writing a
listen-fire automation over MCP, the checker refusing a stage Attio doesn't
have, a one-token fix, and the saved automation then running on a real email.
The run includes one small extraction call. The fakes stand in for Gmail,
Attio and Slack.

How to record it is in `../README.md`; its data build writes
`listen-fire-site/video/dealflow/data.js`.

## What is in it

- `programs/draft.mvt`: the agent's first draft. It uses the user's word
  "Sourcing", which isn't one of Attio's stages, so `saveAutomation` refuses
  it with `MOV_ENUM_UNKNOWN_VALUE`.
- `programs/fixed.mvt`: the one-token fix ("Sourced"), which saves and goes live.
- `programs/founder_email.txt`: the founder's email body.
- `capture.sh`: provisions Gmail and Slack, plays the agent, sends the email
  through the fake Gmail poll, and captures the run.
- `build_data.cjs`: the captures into the video's `data.js`.
