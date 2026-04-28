# Changelog

All notable changes to this project are recorded by calendar day.

## 2026-04-28

### Trace Model

- Fixed root span naming to `openclaw_request`.
- Fixed run span naming to `agent_run`.
- Removed `assistant_message` span from the runtime model.
- Renamed runtime reasoning span from `assistant_thinking` to `thinking`.
- Changed `thinking` span attributes:
  - `span.kind` is now `thinking`
  - `session_channel` replaces the old `channel` field on the `thinking` span
  - `output_summary` replaces the old reasoning preview field
  - `output_text_length` replaces the old reasoning length field

### Fallback Behavior

- Added transcript-based fallback emission for `thinking` spans when `message.processed` is missing.
- Added transcript-based fallback emission for tool spans when runtime tool events are missing.
- Kept transcript-derived model span fallback for environments that only emit coarse session lifecycle events.

### Tooling And Tests

- Added regression coverage for transcript-driven `thinking` span emission.
- Added regression coverage for replaying transcript tool calls into synthetic tool spans.
- Updated README and README_ZH to reflect the current trace naming and span behavior.
