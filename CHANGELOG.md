# Changelog

Current work is recorded by calendar day. Historical entries before the current day are backfilled by week.

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
- Backfilled older changelog entries into weekly summaries.

## Week of 2026-04-20

### Docs And Naming

- Added Dataway-oriented configuration examples and follow-up README refinements.
- Renamed session key channel-related fields for clearer normalized trace attributes.
- Continued README cleanup and usage guidance improvements.

### Session And Multi-Agent Support

- Fixed multi-agent session metadata alignment so traces can carry more accurate session context.

## Week of 2026-04-13

### Exporters And Resource Attributes

- Added configurable metrics and logs exporters.
- Unified resource attribute configuration and compatibility aliases.
- Improved exporter-side observability for OTLP delivery behavior.

### Session Tags

- Extracted structured tags from session keys, including session namespace, channel, agent, scope, and target.

## Week of 2026-04-06

### Service Architecture

- Split the OTEL plugin service into clearer modules.
- Stabilized skill tracing behavior and made trace path configuration explicit.

### Trace Semantics

- Added skill call spans in addition to summary skill spans.
- Normalized OTEL field mapping and improved support for global tags.

## Week of 2026-03-23

### OpenClaw Runtime Coverage

- Enriched OpenClaw tool trace telemetry.
- Added support for newer OpenClaw diagnostics metrics.

### Documentation

- Added bilingual README support with English and Chinese copies.

## Week of 2026-03-16

### Project Bootstrap

- Initialized the OpenClaw OTEL plugin repository and baseline implementation.
- Added early installation, build, and gateway restart guidance.
- Iterated on initial README and endpoint examples.
