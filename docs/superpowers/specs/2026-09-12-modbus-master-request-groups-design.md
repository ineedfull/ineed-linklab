# Modbus Master Nested Request Groups Design

## Goal

Model a Modbus master as one connection containing business-oriented request groups. Each group represents one Slave device or business unit and contains multiple independently scheduled read requests. Each request owns one Modbus function code and one contiguous address range, then decodes that response into multiple business data points.

This design replaces the version 2 assumption that one request group is itself one Modbus request. It preserves the existing TCP/RTU runtime boundary, immediate read/write tools, endpoint storage, and all persisted history.

## Scope

This change includes:

- nested request-group, request, and data-point configuration;
- CRUD, copy, reorder, enable, and single-run actions for groups and requests;
- independent request polling intervals with serialized endpoint execution;
- group execution with success, partial-success, and failure summaries;
- request-level runtime state, group-level aggregate state, and correlated run records;
- automatic migration of version 2 request groups without startup writes;
- component, model, persistence, scheduler, native-runtime, and E2E regression coverage.

Automatic request merging/splitting, persistent time-series point history, alarms/rules, multi-target TCP connections, and arbitrary vendor byte permutations remain later work.

## Domain Model

The hierarchy is:

```text
Master endpoint
└── Request group (one Slave ID)
    ├── Read request (one function code and contiguous range)
    │   └── Data points decoded from this response
    └── Read request (a different function code/range/period is allowed)
        └── Data points decoded from this response
```

Responsibilities are intentionally separate:

- Master endpoint: transport settings, default timeout/retry policy, reconnect policy, auto-start, and minimum inter-request gap.
- Request group: business name, description, Slave ID, enabled state, and display/execution order.
- Read request: name, function code, start address, quantity, independent polling interval, optional timeout/retry overrides, enabled state, and order.
- Data point: response offset, type, byte/word order, optional bit index, scaling, display, range, invalid-value policy, and enabled state.

A request group cannot span multiple Slave IDs. A group may contain FC01, FC02, FC03, and FC04 requests at the same time. Protocol execution remains one request followed by one response.

## Configuration Model

Existing connection fields keep their paths. The master configuration becomes version 3:

```js
{
  configVersion: 3,
  description: '',
  enabled: true,
  unitId: 1,
  timeoutMs: 1000,
  retryCount: 0,
  retryIntervalMs: 200,
  autoReconnect: false,
  scheduler: { minGapMs: 50, autoStart: false },
  requestGroups: [{
    id: 'boiler-room',
    name: 'Boiler room device',
    description: 'Production boiler controller',
    unitId: 1,
    enabled: true,
    order: 0,
    requests: [{
      id: 'process-values',
      name: 'Process values',
      enabled: true,
      order: 0,
      functionCode: 3,
      startAddress: 100,
      quantity: 10,
      intervalMs: 2000,
      timeoutMs: null,
      retryCount: null,
      retryIntervalMs: null,
      dataPoints: [{
        id: 'temperature',
        key: 'temperature',
        name: 'Temperature',
        enabled: true,
        offset: 0,
        dataType: 'float32',
        length: 2,
        byteOrder: 'big-endian',
        wordOrder: 'high-first',
        bitIndex: null,
        scale: 1,
        valueOffset: 0,
        unit: '',
        decimals: null,
        minimum: null,
        maximum: null,
        invalidPolicy: 'mark-bad',
        saveHistory: false
      }]
    }]
  }]
}
```

The top-level `unitId` remains a default for newly created groups and for legacy configurations. Request timeout and retry overrides inherit the master values when null. Group-level timeout, retry, function, range, and interval fields do not exist in version 3.

## Compatibility And Migration

Configuration is stored inside the existing endpoint `config_json`; no database schema migration is required.

- A legacy master with no `requestGroups` loads as version 3 with an empty request-group list and auto-start disabled unless explicitly configured.
- Every version 2 group retains its ID, name, Slave ID, enabled state, order, and data points.
- Its function code, range, interval, timeout, and retry fields move into one generated child request.
- The generated request ID is derived deterministically from the group ID, and its name is derived from the old group name, so repeated normalization is stable.
- Existing point IDs, keys, types, byte order, word order, ranges, scaling, units, and invalid-value policy remain unchanged.
- Loading and normalization never write to SQLite. The normalized version 3 structure is persisted only after an explicit user save.
- Endpoint, frame, log, send-history, and settings rows are never deleted, recreated, or rewritten during migration.
- Workspace schema version 1 remains valid because nested requests are part of endpoint JSON.
- Version 3 normalization is idempotent and does not regenerate IDs or reorder collections.

## Validation

- Group IDs are unique per master; each group requires a name and Slave ID from 1 through 247.
- Request IDs are unique within a group; each request requires a name and allows only FC01 through FC04.
- Point IDs and point keys are unique across the entire request group, not merely within one request.
- Request order is normalized within its group; group order is normalized within the master.
- Polling intervals range from 100 through 3,600,000 milliseconds.
- FC01/FC02 quantity is at most 2000; FC03/FC04 quantity is at most 125; every range ends at or before address 65535.
- Every enabled point fits inside its parent request response. Disabled points may remain parked outside the active range.
- FC01/FC02 points must be Boolean and do not use a register bit index.
- Register-backed Boolean points require bit index 0 through 15.
- Register ranges may overlap only for distinct bit views of the same register.
- Timeout and retry overrides are validated before save and inherit master defaults only when null.

## Scheduling

The shared Workbench scheduler continues to own one queue per master endpoint. A read request, not a request group, is the smallest scheduled unit.

- Due requests are selected by due time, group order, request order, then stable IDs.
- Only requests whose group and request are both enabled can run periodically.
- Each request schedules its next run from its own completion time and interval, preventing overlap.
- Periodic requests, manual group execution, manual request execution, retries, immediate reads, and confirmed writes share the same endpoint queue and minimum gap.
- A request applies its own timeout/retry overrides or inherits master defaults.
- A failed request completes its retry policy before the scheduler advances, but it does not stop later due requests.
- Stop, close, session replacement, endpoint delete, workspace reset/import, and disposal cancel timers, retry waits, queued manual work, and remaining requests in a manual group run.
- Saving active configuration rebuilds the due-request set without allowing stale configuration to execute.

Manual execution has two commands:

- Enabled state controls periodic scheduling; explicit manual commands remain available for diagnostics.
- Run request: execute one selected request even if that request or its parent group is disabled, provided the endpoint session is open.
- Run group: execute all enabled child requests in configured order even when the group itself is disabled. A child failure is recorded and execution continues. The final summary is `success`, `partial`, or `failed` and contains one result per attempted request.

## Runtime State

Volatile state remains outside persisted endpoint configuration.

- Request state: latest raw response, decoded points, last attempt/success/failure times, last error, duration, success/failure counts, consecutive failures, and last-good readings.
- Group state: enabled state, request totals, running state, aggregate success/partial/failure result, and the most recent group-run summary.
- Master state: active scheduling state and a bounded run-record list.

Run records contain both `requestGroupId` and `requestId`, plus group/request names, result, attempt, duration, error, timestamp, and optional native transaction. Point quality remains `good`, `bad-communication`, `bad-value`, `uncertain-overflow`, or `disabled`.

Native transaction payloads retain optional `requestGroupId` and gain optional `requestId`. Callers that omit either field remain compatible.

## User Interface

The Request Groups tab uses the approved expandable hierarchy:

- A group header shows name, description, Slave ID, enabled state, request count, point count, aggregate state, and group actions.
- Expanding a group shows ordered request rows with function code, address range, interval, point count, last result, and actions.
- Expanding a request previews its business data points and latest values.
- Group actions include edit, copy, reorder, enable, delete, add request, and run group.
- Request actions include edit, copy, reorder, enable, delete, and run request.

Editing is split into two focused dialogs:

- Group editor: name, description, Slave ID, and enabled state.
- Request editor: name, enabled state, function code, range, interval, timeout/retry overrides, and the existing data-point editor.

The Live Data tab groups rows by request group and request. The Run Records tab identifies both levels and displays group-run summaries without hiding child-request errors. Immediate read and write tools keep their existing behavior.

## Error Handling

- Configuration errors prevent saving and point to the exact group, request, or point field.
- A Modbus protocol exception fails only the active request and does not close the connection.
- A connection-level I/O failure retires the session and allows configured reconnect behavior.
- Manual group execution records every attempted request and reports partial success when results are mixed.
- `keep-last-good` uses only a prior `good` reading from the same point in the same request.
- Removing or moving a request cannot leak its runtime state into another request with a different ID.
- Bounded records and point snapshots prevent unbounded in-memory growth.

## Testing

- Configuration tests cover version 2 to version 3 migration, idempotence, cloning, field ownership, nested uniqueness, ranges, and point validation.
- Decoder tests verify all supported point types and last-good isolation per request.
- Fake-clock scheduler tests cover independent request intervals, deterministic ordering, minimum gaps, request retries, disabled parents/children, manual request execution, group success/partial/failure, cancellation, reconciliation, and stale-state removal.
- Component tests cover group expansion, nested CRUD, copy/reorder/enable/delete actions, both manual execution paths, responsive layout, and error display.
- Electron and Rust persistence tests round-trip version 3 endpoint JSON while proving existing history remains unchanged.
- Native service tests verify optional group/request correlation without breaking legacy immediate operations.
- E2E tests exercise multiple function codes in one group, independent polling, live values, partial failures, run records, and Electron/Tauri visual parity.
- Cross-runtime TCP/RTU tests continue to verify Electron Master/Rust Slave and Rust Master/Electron Slave communication.

## Acceptance Criteria

- One request group can contain multiple FC01-FC04 requests for exactly one Slave ID.
- Each request has an independent polling interval and data-point collection.
- Periodic and manual operations remain serialized per endpoint.
- Group execution continues after child failures and reports an accurate aggregate result.
- Existing version 2 groups and data points load without loss and persist as version 3 only after user action.
- No database or history data is deleted or rewritten during upgrade.
- TCP and RTU masters expose identical configuration and runtime behavior.
