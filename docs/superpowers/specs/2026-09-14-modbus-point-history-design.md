# Modbus Data Point History and Trends Design

## Status

Approved in conversation on 2026-09-14.

## Scope

This design adds durable history and trend analysis for decoded Modbus Master data points. It is the first of three independent follow-up projects:

1. Data point history and trends (this design).
2. Alarm rules and alarm lifecycle.
3. Request merge and split optimization.

Alarm evaluation and request optimization are explicitly out of scope. The implementation must not pre-emptively add their database tables, APIs, or UI.

## Goals

- Persist selected Master data point readings without blocking polling.
- Preserve both protocol-level raw values and the decoded business value.
- Record quality transitions and communication failures for diagnosis.
- Provide useful trend analysis for numeric, Boolean, and String points.
- Produce identical persistence and query behavior in Electron and Tauri.
- Upgrade existing installations without rewriting endpoint configuration or deleting existing history.

## Non-Goals

- Slave data map history.
- Alarm conditions, acknowledgement, or notification delivery.
- Automatic request grouping, merging, or splitting.
- Cloud synchronization or remote databases.
- Continuous background polling while the desktop application is closed.

## Existing-System Constraints

- Master polling and point decoding remain in the shared Workbench model.
- Electron and Tauri retain ownership of native SQLite persistence.
- Existing frame, log, send-history, endpoint, settings, and workspace data must remain byte-for-byte untouched by the new migration unless the user invokes an existing operation that intentionally changes them.
- Existing point configurations may contain `saveHistory` but do not contain `historyMode`.
- A loaded legacy configuration must not be silently written back merely because defaults were applied in memory.
- All timestamps use Unix epoch milliseconds.

## User Configuration

Each Master data point exposes two related fields:

- `saveHistory: boolean`
- `historyMode: "on-change" | "every-poll"`

Rules:

- Existing and newly created points default to `saveHistory: false`.
- Enabling history defaults `historyMode` to `on-change`.
- A legacy point with `saveHistory: true` and no `historyMode` is interpreted as `on-change` without an automatic database write.
- `every-poll` stores one record for every completed poll outcome.
- Disabling history stops future capture and does not delete existing records.

The point editor presents “Save history” as a binary control. When enabled, it presents “On change” and “Every poll” as a two-option segmented control.

## Capture Semantics

### Captured Values

Every history row contains:

- Endpoint ID.
- Request group ID.
- Request ID.
- Data point ID and key.
- Snapshots of point name, data type, and unit.
- Raw coil or register values as lossless JSON.
- Decoded engineering value as lossless JSON.
- A nullable numeric projection for chart aggregation.
- Display text.
- Quality code and nullable reason.
- Capture timestamp in epoch milliseconds.

The lossless engineering value preserves `Int64` and `UInt64` strings exactly. The numeric projection is populated only when the decoded value can be represented as a finite number suitable for plotting and aggregation.

### On-Change Mode

The collector writes the first observed outcome after capture starts. It writes another row when any member of the change signature changes:

- Lossless engineering value.
- Quality code.
- Quality reason.

Repeated identical communication failures do not create duplicate rows. A transition from good to communication failure, between different error reasons, from invalid to good, or between Boolean/String values does create a row.

The in-memory comparison state is scoped by endpoint ID, request group ID, request ID, and point ID. It resets when the endpoint session changes, the point configuration changes, the workspace resets/imports, or the model is disposed. A new session therefore records its first observed outcome even if it equals the previous session's last value.

### Every-Poll Mode

Every completed request outcome creates a row for each enabled point whose history is enabled. Retries within one logical request execution do not create intermediate point rows; only the final success or exhausted failure is captured.

Disabled points do not create history rows. An all-disabled request group produces no point history.

## Architecture

The shared Workbench owns a `ModbusPointHistoryCollector` because it already owns the canonical point decoding behavior. Native runtimes do not duplicate byte-order, word-order, scaling, range, or invalid-policy logic.

The data flow is:

```text
Master scheduler
  -> decoded point outcome
  -> ModbusPointHistoryCollector
  -> bounded batch queue
  -> runtime adapter
  -> Electron or Tauri native persistence
  -> SQLite modbus_point_history
  -> paged/detail and bucketed/trend queries
  -> Master data trends tab
```

The scheduler publishes a complete point outcome after a request succeeds or exhausts its configured retries. The collector decides whether capture is enabled and whether the outcome changed. It snapshots accepted records immediately so later config or state mutation cannot alter queued data.

## Collector and Backpressure

- Flush when the queue reaches 200 rows or the oldest queued row reaches one second.
- Limit the in-memory queue to 2,000 rows.
- When the limit is exceeded, discard the oldest queued rows, increment a dropped-row counter, and expose the condition in trend-page status.
- Retry transient persistence failures a finite number of times using the same bounded persistence pattern already used by runtime history.
- Persistence failure never blocks or stops Master polling.
- Explicit flush barriers run before application shutdown, workspace import, and history clearing.
- Disposal prevents late callbacks from mutating Workbench state.

Collector status contains pending row count, dropped row count, failed batch count, last successful flush time, and the last persistence error.

## Database Schema

A new append-only migration creates `modbus_point_history`. The logical schema is:

| Column | Purpose |
| --- | --- |
| `id` | Monotonic SQLite primary key used as a stable paging tie-breaker. |
| `endpoint_id` | Parent endpoint identity. |
| `request_group_id` | Request group identity at capture time. |
| `request_id` | Request identity at capture time. |
| `point_id` | Stable point identity. |
| `point_key` | Business key snapshot. |
| `point_name` | Display name snapshot. |
| `data_type` | Point data type snapshot. |
| `unit` | Unit snapshot, nullable. |
| `raw_json` | Lossless JSON array of raw coils/registers. |
| `value_json` | Lossless JSON engineering value. |
| `numeric_value` | Nullable finite numeric projection. |
| `display_value` | Display text captured at the time. |
| `quality` | Quality code. |
| `reason` | Nullable quality/error reason. |
| `created_at` | Epoch-millisecond capture time. |

Required indexes support:

- Endpoint/request-group/request/point/time descending detail paging.
- Endpoint/time retention deletion.
- Endpoint/request/time filtering.

Foreign-key behavior follows existing endpoint ownership: an explicit user endpoint deletion cascades its point history. Schema migration, application upgrade, history retention, and workspace load never delete endpoint configuration.

Batch writes are atomic: either every validated row in a batch is committed, or none is. Native validation rejects unsafe timestamps, malformed IDs, invalid quality values, non-finite numeric projections, and invalid JSON shapes before mutation.

## Runtime Contract

The shared runtime adapter gains a focused Modbus point-history surface:

- `modbusHistory.recordBatch(rows)`
- `modbusHistory.querySeries(query)`
- `modbusHistory.queryRows(query)`
- `modbusHistory.exportCsv(query)`
- `modbusHistory.clear(query)`
- `modbusHistory.cleanup(retention)`
- `modbusHistory.flush()`
- `lifecycle.onBeforeShutdown(listener)`
- `lifecycle.readyForShutdown(requestId)`

The native contract must remain envelope-compatible with existing Electron and Tauri adapter conventions. Query validation, paging bounds, timestamp bounds, ordering, aggregation semantics, and serialized values must match across runtimes.

`queryRows` orders by `created_at DESC, id DESC` and uses bounded page sizes. A point identity is the exact `{ requestGroupId, requestId, pointId }` triple because existing configurations only guarantee point-ID uniqueness within a request group. `querySeries` accepts one to six such point identities, an inclusive time range, and a target bucket count derived from chart width.

`exportCsv` opens the native save dialog, streams the validated active query to a temporary file, atomically replaces the selected destination, and reports saved/cancelled status. The renderer never receives an unbounded export result. `clear` requires an endpoint ID and optionally accepts point identities and a bounded time range; the UI confirms the exact scope before calling it. `cleanup` accepts only the shared retention-setting enum and returns the deleted row count plus completion time.

Electron and Tauri add the same bounded shutdown handshake. Before closing the main renderer, the native host emits one `onBeforeShutdown` request with a unique request ID. Workbench flushes its unsent collector queue, calls native `modbusHistory.flush`, then acknowledges that exact ID through `readyForShutdown`. The host proceeds with transport and database shutdown after acknowledgement or after a two-second deadline, so a hung renderer cannot block application exit. Repeated close/exit signals join the same in-flight handshake.

## Trend Aggregation

Long ranges are reduced in SQLite/native query code rather than loading every row into the renderer. For numeric values, each bucket returns:

- First and last value with timestamps.
- Minimum and maximum value with timestamps.
- Good and abnormal sample counts.
- The worst quality observed in the bucket.

The result retains extrema so short spikes remain visible. Boolean series return state transitions and abnormal intervals. String series return timestamped change events. Communication/invalid records remain visible even when no numeric value exists.

The query layer caps returned points and rejects ranges or bucket counts outside documented safe limits.

## Trend User Interface

The Master detail view gains a “Data trends” tab using the approved cross-point comparison layout.

Apache ECharts is added as a local Workbench dependency for time axes, synchronized cursors, data zoom, line/step series, quality markers, and accessible chart rendering. No chart assets, scripts, or data are loaded from a remote host.

### Selection

- A left-side tree groups points by request group and request.
- The user can select at most six points.
- All configured points are selectable. A point with capture disabled can still show previously recorded history; a point with no rows shows the empty state.
- Selection and time range are local view state and do not rewrite endpoint configuration.

### Charts

- Points with the same unit share one chart.
- Different units render in vertically aligned charts sharing the same time axis, zoom, and cursor.
- Numeric values use line charts.
- Boolean, coil, and register-bit values use step charts.
- String values use an event timeline rather than a numeric axis.
- Communication failures, invalid values, and out-of-range values render as quality markers with reason tooltips.
- The view supports `1 hour`, `24 hours`, `7 days`, `30 days`, and a bounded custom range.

### Summary and Detail

The summary table shows current/last value, minimum, maximum, change count, abnormal count, and latest quality for each selected point. A paged detail view shows timestamp, raw value, engineering value, unit, quality, and reason.

CSV export uses the active endpoint, selected points, and time range. It includes timestamp, point identity/name, raw value, engineering value, unit, quality, and reason. It does not export unselected points.

## Retention

A global string setting named `modbusPointHistoryRetention` controls point-history retention:

- `7-days`.
- `30-days` (default).
- `90-days`.
- `forever`.

Retention cleanup runs once after application startup and then every 24 hours while the application remains open. Changing the setting applies the new policy immediately. Cleanup affects only `modbus_point_history`; it does not clear transport frames, logs, send history, write transactions, or endpoint configuration.

Storage statistics add point-history row count, estimated logical payload bytes, and the last successful retention cleanup time. Estimated payload bytes are the SQLite sum of the byte lengths of the point-history text/blob payload columns plus the fixed numeric fields; the UI labels the value as an estimate rather than physical file allocation.

## Error Handling and UX States

- Empty history presents a neutral empty state rather than a chart error.
- A query failure preserves the current selection and offers retry.
- Collector failures appear in the trends status area without changing endpoint connection state.
- Dropped queued rows show an explicit warning and count.
- A point renamed or removed after capture remains identifiable through row snapshots.
- Deleted endpoint history is not recoverable through the application and remains subject to the existing endpoint-deletion confirmation flow.

## Migration and Compatibility

1. Apply an additive schema migration exactly once.
2. Do not update existing endpoint rows during migration.
3. Normalize missing `historyMode` in memory only.
4. Preserve unknown configuration keys during load/save and workspace round trips.
5. Include point-history data in neither existing workspace export nor import during this phase; workspace import flushes pending history first and then follows its existing configuration-only behavior.
6. Existing history-clear operations retain their current meaning. The point-history UI provides a separately named clear action so users cannot accidentally broaden an old command's scope.

## Verification

Tests must cover:

- Legacy and new point default behavior without implicit persistence.
- Additive migration idempotence and preservation of existing database rows/bytes.
- On-change first value, value change, quality change, reason change, and duplicate suppression.
- Every-poll capture and retry-final-outcome semantics.
- Disabled point and all-disabled request behavior.
- Raw and engineering value snapshots, including exact Int64/UInt64 values.
- Atomic batch validation and rollback.
- Queue flush thresholds, bounded overflow, finite retry, barriers, and disposal.
- Detail paging order and safe bounds.
- Numeric bucket extrema, Boolean transitions, String events, and abnormal samples.
- Retention options and isolation from every existing history/config table.
- CSV filtering and escaping.
- Electron/Tauri runtime contract parity.
- Trend selection limit, unit grouping, chart type selection, empty/loading/error states, and status warnings.
- A real Master polling flow that produces queryable point history in both runtimes.

## Acceptance Criteria

- Enabling history on a point produces durable, queryable rows according to its selected mode.
- Restarting the application retains and displays those rows.
- A 30-day numeric range remains responsive through bounded aggregation rather than full-row loading.
- Cross-point comparison supports up to six points without mixing different units on one axis.
- Raw, engineering, and quality information can be inspected for any detail row.
- Polling cadence remains unaffected by slow or temporarily failing persistence.
- Application shutdown and destructive history operations flush pending accepted rows first.
- Existing endpoint configuration and all pre-existing history survive application upgrade unchanged.
- Electron and Tauri pass the same behavioral contract fixtures.
