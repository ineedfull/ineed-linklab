# Unified Millisecond Timestamps Design

## Goal

Display every message and log timestamp in one local-time format, keep the complete value on one line where practical, and guarantee that newly persisted frame and log history uses epoch-millisecond integers.

The canonical display format is:

```text
YYYY-MM-DD HH:mm:ss.SSS
```

## Scope

- Realtime messages and logs.
- Message-history and log-history tables and details.
- Electron and Tauri frame/log history persistence.
- The shared settings contract and Settings UI.

Endpoint/template creation timestamps and migration of old history rows are outside this change. Existing history is displayed from its stored integer value without rewriting it.

## Presentation Contract

`formatTimestamp(timestamp)` is the only timestamp presentation function used by the workbench. It no longer accepts a display mode.

- The function uses the user's local timezone.
- Year, month, day, hour, minute, and second are zero-padded to two digits where applicable.
- Milliseconds are always present and padded to three digits.
- Invalid legacy values render as `--` instead of producing an exception or an ambiguous partial value.
- ISO output is removed from the workbench.

`FrameList`, `LogList`, and `HistoryWindow` call this shared function directly. No component formats dates independently.

## Settings Compatibility

The Settings panel removes the time-display selector. `timeDisplayMode` is removed from the shared settings schema and from workbench preference consumers.

An existing `timeDisplayMode` row in a local database becomes an unknown setting. Existing settings readers already ignore unknown rows, and a later settings save removes unknown rows through the normal schema-owned save path. No dedicated database migration is added.

The renderer must not use an old persisted `iso` value after this change.

## Layout

Timestamp text must not wrap.

- Realtime log rows reserve approximately `168px` for time in normal mode and `204px` in large-font mode.
- Message-card header timestamps use `white-space: nowrap` and retain their existing right alignment.
- History tables reserve approximately `180px` for the first column in normal mode and enough additional width in large-font mode for the larger monospace text.
- History tables receive a stable minimum width. On a narrow window, the table region scrolls horizontally instead of wrapping or collapsing the timestamp.
- History detail timestamps also remain on one line.

The remaining row width belongs to the message column. Time-column growth must not introduce page-level horizontal scrolling or overlap adjacent columns.

## Millisecond Timestamp Ownership

The native transport creates each event timestamp once:

- Electron uses `Date.now()`.
- Tauri uses `SystemTime::now().duration_since(UNIX_EPOCH).as_millis()`.

For a status event with a structured log, the status event, log object, queued persistence row, and SQLite `created_at` value all use that exact integer. Persistence does not call the clock again.

Frame timestamps follow the same rule: the transport assigns the timestamp when it creates the frame, and persistence stores that value unchanged.

## Persistence Validation

Electron and Tauri validate new frame/log history timestamps before a batch transaction writes any row.

- The value must be a non-negative safe integer supported by the runtime and SQLite representation.
- A newly produced runtime-history timestamp must be at least `1_000_000_000_000`, preventing a seconds-since-epoch value from being accepted as milliseconds.
- A bad timestamp rejects the affected batch before partial insertion.
- Persistence never multiplies a seconds value by 1000 and never silently substitutes the current time.

This stricter check applies to newly inserted frame and log history only. It does not reinterpret existing rows or alter endpoint/template timestamp compatibility.

## Data Flow

1. Electron or Tauri creates a frame or status event and captures one epoch-millisecond integer.
2. A structured log, when present, receives the same timestamp as its status event.
3. The renderer receives the event and keeps the integer in bounded realtime state.
4. Native persistence snapshots the same integer, validates its millisecond range, and writes it to SQLite.
5. Realtime and history views pass the integer to `formatTimestamp` for local-time display.

No formatted date string is stored in SQLite.

## Error Handling

- Malformed runtime timestamps continue to be rejected by the runtime contract before realtime state mutation.
- Seconds-level or otherwise invalid history timestamps fail persistence validation with a field-specific error.
- A persistence timestamp error is reported through the existing persistence error channel and does not terminate a healthy transport session.
- Invalid old rows remain queryable; their timestamp cell displays `--`.

## Verification

- Unit tests assert an exact local value including `.SSS`, independent of ISO formatting.
- Settings tests verify that `timeDisplayMode` is absent and old unknown rows do not affect presentation.
- Component and E2E tests cover realtime messages, realtime logs, both history kinds, normal font, large font, and compact-window no-wrap behavior.
- Electron tests verify `Date.now()`-sourced frame/log timestamps are preserved exactly through SQLite and reject seconds-level batch input.
- Tauri tests verify `as_millis()`-sourced frame/log timestamps are preserved exactly through SQLite and reject seconds-level batch input.
- Cross-runtime PTY acceptance asserts current epoch-millisecond values, status/log equality, persisted-row equality, and unchanged descending SQL ordering.
- The complete Phase 03 verification gate must remain green.
