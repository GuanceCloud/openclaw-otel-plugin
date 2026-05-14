# Changelog

Current work is recorded by calendar day. Historical entries before the current day are backfilled by week.

## 2026-05-14

### Trace Debugging

- Fixed transcript fallback replay so snapshot-backed spans now carry `run_id` when a run is reconstructed from session transcript state.
- Fixed transcript-replayed `llm` spans so per-turn token usage is written back onto trace attrs, transcript-only runs now accumulate token totals onto `agent_run` / `openclaw_request` summary spans, and runtime-covered model turns are not double-counted during replay.
- Added `usage_cache_total_tokens` trace tag as the sum of `usage_cache_read_input_tokens` and `usage_cache_write_input_tokens`.
- Restored request trace grouping to session/request lineage instead of forcing one trace per `run_id`, while keeping `run_id` on emitted spans for correlation.
- Preserved the first `run_id` on request / run summary spans when a request triggers multiple internal runs, and added `run_ids` as the ordered aggregate of every observed run id on that trace.
- Simplified trace payload debugging back to a single `tracePayloadDebugEnabled` switch so enabling debug always logs the full exported payload.
- Extended trace export payload debug logs to include `run_id` alongside `trace_id`, `span_id`, and `parent_id`.

## 2026-05-12

### Installation Flow

- Fixed `scripts/install.sh` cleanup so successful installs no longer end with `tmp_dir: 未绑定的变量`.
- Bundled a CommonJS runtime entrypoint at `dist/index.cjs` for release/runtime use.
- The installer now links the host `openclaw` package into the plugin directory under `node_modules/openclaw`, so release installs reuse the local OpenClaw runtime instead of bundling the full host package into the plugin artifact.
- Added installer parameters for Guance GTrace:
  - `--type gtrace`
  - `--endpoint`
  - `--x-token`
  - `--tag key=value`
- When `--type gtrace` is used, the installer now writes the following defaults:
  - `tracePath = v1/write/otel-llm`
  - `metricsPath = v1/write/otel-metrics`
  - `logsEnabled = false`
  - `logsPath = v1/write/otel-logs`
  - `headers.to_headless = true`
- When `--type gtrace` is used, the installer also removes `app_name` and `app_id` from the default `resourceAttributes`.
- `--type gtrace` now requires both `endpoint` and `X-Token`.
- Every `--tag key=value` is merged into `resourceAttributes`.
- Updated README and README_ZH quick-install examples to use safer chained commands.

### OTEL Metric Alignment

- Kept `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` as OTEL-native metric names in documentation only; the plugin no longer writes custom token or operation data into the `gen_ai.client.*` namespace.
- Added `gen_ai.agent.request.token.input`, `gen_ai.agent.request.token.output`, and `gen_ai.agent.request.token.total` for per-request token totals emitted once when a request finishes.
- Added `gen_ai.agent.token.usage` as the plugin-owned model token usage histogram for runtime `model.usage` events and transcript / synthetic fallback replay.
- Removed legacy `openclaw.*` metric dual-write emission, keeping current reporting on the `gen_ai.client.*`, `gen_ai.agent.*`, and `gen_ai.runtime.*` namespaces.
- Added `gen_ai.agent.operation.count` and `gen_ai.agent.operation.duration` for model/tool/skill operation reporting, and removed the temporary dual-write to `gen_ai.client.operation.duration`.

## 2026-05-11

### GenAI Metrics And Tags

- Promoted `gen_ai.client.*`, `gen_ai.agent.*`, and `gen_ai.runtime.*` as the current recommended metric namespaces.
- Split session token aggregation into dedicated counters:
  - `gen_ai.agent.session.token.input`
  - `gen_ai.agent.session.token.output`
  - `gen_ai.agent.session.token.total`
- Normalized trace and metric correlation fields to canonical names such as `session_id`, `session_key`, `channel`, `provider_name`, and `request_model`.
- Removed `gen_ai.*` trace tag alias dual-write and kept canonical query fields only.
- Changed `gen_ai.client.operation.duration.operation_name` semantics to `model` / `tool` / `skill`, so tool and skill durations can be queried separately.
- Added `model_name` attribution to `operation_name=tool` so tool metrics can be correlated with the upstream model choice.

### Session And Tooling Semantics

- Fixed session total token aggregation so transcript `totalTokens` snapshots are not double-counted as cumulative totals.
- Backfilled `session_id`, `session_key`, and `channel` onto tool and skill spans when runtime events do not carry them directly.
- Unified runtime lifecycle span session resolution so lifecycle spans follow the canonical session identity.

### Packaging And Documentation

- Added release packaging, install, and update scripts for the plugin delivery workflow.
- Added `BUILDING.md` and repo-level `AGENTS.md`.
- Updated README and README_ZH to focus on current `gen_ai.*` telemetry naming and plugin installation guidance.

## 2026-05-07

### Session Metrics

- Switched session token aggregation to runtime `model.usage` events so `openclaw.session.tokens.*` no longer depends on transcript `message.usage`.
- Kept `openclaw.session.traces` on session transcript counting while preserving periodic export for active sessions.

### Trace Model

- Switched request scoping from session-level reuse to one trace per inbound user message.
- Fixed repeated `message.queued` handling so a pending run is reused instead of starting a duplicate trace.
- Added replay watermarks so the same transcript is only finalized once across `message.processed` and trailing `session.state idle` events.
- Made the model span mandatory when transcript metadata already includes `provider` and `model`, even if runtime `model.usage` is missing.
- Renamed model span resources to the fixed name `llm` instead of embedding `provider/model` in the span name.
- Switched transcript replay from one synthetic span per run to one `llm` per assistant turn, so multi-tool sessions show `model -> tool -> model` loops correctly.
- Moved per-turn transcript replay to `message.processed` first and kept `session.state idle` as a fallback-only close path.

### Runtime Lifecycle

- Added explicit runtime lifecycle spans for `channel_ingress`, `dispatch_queue`, `session_processing`, `runtime_orchestration`, and `channel_egress`.
- Split queue wait from execution time so request spans can start near the real ingress timestamp while queued work is shown separately.
- Removed standalone queue and heartbeat traces, keeping those diagnostics in metrics and logs instead.

### Skill And Tool Coverage

- Added transcript-backed skill inference for dashboard-style tool activity.
- Added `skill_call` wrapping for tool invocations such as `edit` in addition to `write` and `exec`.
- Preserved `openclaw.skill.*` attributes alongside normalized skill aliases so downstream filters can query skill names directly.

### Tooling And Tests

- Added regression coverage for request reuse, replay watermark deduplication, and transcript-first `message.processed` replay.
- Updated README and README_ZH to reflect the current trace naming and lifecycle span behavior.

## 2026-05-06

### Session Metrics

- Added session-scoped metrics with `session_id` tagging:
  - `openclaw.session.tokens.input`
  - `openclaw.session.tokens.output`
  - `openclaw.session.tokens.total`
  - `openclaw.session.traces`
- Switched session metrics from run-end emission to a scanner that only tracks active sessions on the `30s` cadence.
- Report session counters as scan-time deltas derived from transcript-backed cumulative totals, so repeated scans do not double count.

### Metrics Export

- Changed the default metrics export interval from `15s` to `30s`.
- Updated README and README_ZH examples and config reference to reflect the new default export interval and session metric behavior.

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
