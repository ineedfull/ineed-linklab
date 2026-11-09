# Modbus Master Saved Write Commands Design

## Goal

Turn the Modbus master write tab from a one-off form into a reusable collection of named write commands. Each saved definition represents exactly one FC05, FC06, FC15, or FC16 operation. The operator selects the required definition, clicks Run, reviews the existing safety confirmation, and executes only that command.

Also make request-group deletion consistently visible and require confirmation before removing a group and its nested requests and data points.

## Scope

This change includes:

- saved write-command normalization, validation, cloning, ordering, enablement, and persistence;
- create, edit, copy, reorder, enable, delete, and run actions in the write tab;
- explicit confirmation before every device write;
- per-command volatile latest-result display and existing transaction logging;
- a visible request-group delete action with destructive confirmation;
- Electron/Tauri visual and behavioral parity;
- migration and workspace round-trip tests proving old configuration and history remain intact.

Nested write batches, periodic writes, conditional writes, permissions, approval workflows, alarm rules, and durable per-command statistics remain later work.

## Domain Model

Write commands belong directly to one Modbus master endpoint:

```text
Master endpoint
├── Read request groups
│   └── Read requests
└── Saved write commands
    ├── Start pump: FC05, Slave 1, address 10, value true
    ├── Stop pump: FC05, Slave 1, address 10, value false
    └── Set target: FC16, Slave 1, address 20, values [100, 200]
```

One saved write command always maps to one Modbus request and one response. Commands are never scheduled automatically. A disabled command remains saved but cannot be run until it is enabled.

## Configuration

The existing version 3 master configuration gains an optional top-level collection:

```js
{
  configVersion: 3,
  requestGroups: [],
  writeCommands: [{
    id: 'set-target',
    name: 'Set target values',
    description: 'Apply the normal operating target',
    enabled: true,
    order: 0,
    unitId: 1,
    functionCode: 16,
    address: 20,
    values: [100, 200]
  }]
}
```

`quantity` is derived from `values.length` and is not persisted. Boolean commands store actual booleans; register commands store unsigned 16-bit integers. Hexadecimal input is accepted by the editor but normalized to numbers before persistence.

Existing configurations without `writeCommands` normalize to an empty list. Unknown endpoint configuration fields remain untouched. Normalization does not save automatically, and configuration stays at version 3 because this is an optional additive field rather than an incompatible shape change.

## Validation

- IDs are unique within the master; every command requires a nonblank name.
- Slave ID is an integer from 1 through 247.
- Function code is exactly FC05, FC06, FC15, or FC16.
- Address is an integer from 0 through 65535.
- FC05 stores exactly one Boolean value.
- FC06 stores exactly one integer from 0 through 65535.
- FC15 stores 1 through 1968 Boolean values.
- FC16 stores 1 through 123 integers from 0 through 65535.
- The final addressed item cannot exceed address 65535.
- Copying a command creates a fresh ID, appends a copy suffix to its name, and places it last.

Validation errors prevent saving and identify the exact command and field. Native runtime validation remains the final trust boundary.

## User Interface

The Write Operations tab becomes a compact saved-command workspace:

- The toolbar shows enabled and total command counts and an Add command button.
- Each row shows enabled state, name and description, Slave ID, function code, address/range, value preview, latest result, and actions.
- Row actions are Run, Edit, Copy, Move up, Move down, Enable/Disable, and Delete.
- On narrow layouts, identity and metadata may wrap, but the action area remains visible without requiring horizontal page scrolling.
- Empty state text explains that no write commands have been defined and offers the same Add command action.

The command editor is a focused dialog containing name, description, enabled state, Slave ID, function code, address, and values. Changing between coil and register functions updates the value hint and validation without silently coercing invalid entered data.

Run opens the existing destructive confirmation with the command name, Slave ID, function code, address, quantity, and normalized values. Confirmation executes only the selected command. Cancel performs no I/O. While a command is executing, repeat execution is disabled.

The request-group header keeps its normal actions visible. Delete is not placed beyond a clipped minimum-width row. Activating Delete opens a confirmation naming the group and stating how many nested requests and data points will be removed. The delete occurs only after confirmation and only after persistence succeeds.

## Execution And State

Saved commands execute through `scheduler.executeImmediate`, so writes remain serialized with polling, retries, manual reads, and other writes on the same endpoint and continue to respect the master minimum request gap.

The request passed to the runtime is a fresh plain object containing endpoint ID, function code, Slave ID, address, derived quantity, and copied values. No new Electron IPC or Tauri command fields are required.

Latest command result is keyed by command ID in component memory and contains success/failure, timestamp, duration, and error text. Native transactions continue to feed the existing bounded instruction record. Saving, reordering, or toggling commands does not execute them. Closing the endpoint, replacing the session, or disposing the workspace prevents stale confirmations from executing.

## Persistence And Compatibility

- Commands are stored only in the existing endpoint `config_json`.
- No SQLite schema migration or new history table is added.
- Loading an old version 2 or version 3 master performs no persistence write.
- Explicitly saving commands preserves request groups and every unrelated endpoint configuration key.
- Editing master connection settings preserves saved write commands.
- Workspace schema version 1 export/import round-trips saved commands unchanged.
- Endpoint, frame, log, send-history, settings, and existing Modbus transaction rows are never deleted or rewritten by this change.

## Error Handling

- Invalid definitions remain in the editor with field-level messages and are not saved.
- Save failures leave the current list unchanged and display the existing panel error.
- A Modbus exception marks only the executed command as failed and retains its definition.
- A connection-level failure follows the existing session and reconnect behavior.
- Group or command deletion requires confirmation; cancel leaves configuration unchanged.
- Stale confirmation state is cleared when the endpoint, session, or command definition changes.

## Testing

- Model tests cover defaults, normalization, idempotence, validation limits, address overflow, cloning, and preservation of unknown fields.
- Component tests cover visible request-group deletion and confirmation, full write-command CRUD, responsive action visibility, and explicit run confirmation.
- Scheduler tests verify saved commands still use the serialized immediate-operation queue and minimum gap.
- Endpoint editor tests prove connection-setting saves preserve `writeCommands`.
- Electron and Rust persistence tests prove old configurations load without writes and workspace round trips preserve commands and all history.
- E2E tests run different saved FC05 and FC16 commands, verify independent results and instruction records, and compare Electron/Tauri visuals at desktop, compact, and portrait sizes.

## Acceptance Criteria

- Operators can keep multiple named write definitions on one master and run any enabled definition individually.
- Every write still requires explicit confirmation and passes existing protocol validation.
- Writes never run periodically and remain serialized with reads on the endpoint.
- Request-group deletion is visible at supported sizes and cannot occur without confirmation.
- Existing configurations, request groups, endpoint history, and unrelated settings survive upgrade and save operations.
- Electron and Tauri expose equivalent behavior and layout.
