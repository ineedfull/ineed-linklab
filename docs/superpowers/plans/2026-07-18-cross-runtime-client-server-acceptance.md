# Cross-Runtime Client/Server Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repeatable Rust/Tauri-client-to-Electron-server TCP and UDP acceptance scenarios so both cross-runtime client/server directions are verified.

**Architecture:** The existing Node acceptance harnesses continue to own child-process lifecycle and aggregate results. Each harness opens the production Electron server on an ephemeral localhost port, starts the ignored Rust contract test in a new `client` mode with that port in the environment, exchanges fixed request/response bytes, and verifies both runtimes' frames and logs.

**Tech Stack:** Node.js ESM, Electron CommonJS transport services, Rust standard networking, Cargo tests, Node `assert`.

---

## File Structure

- Modify `tooling/tcp-test/localhost-loopback.mjs`: orchestrate the reverse TCP scenario and aggregate server-side peer metrics.
- Modify `apps/tauri/src-tauri/src/tcp.rs`: add the Rust TCP client probe selected by an environment mode.
- Modify `tooling/udp-test/localhost-loopback.mjs`: orchestrate the reverse UDP scenario and aggregate server-side peer metrics.
- Modify `apps/tauri/src-tauri/src/udp.rs`: add the Rust UDP client probe selected by an environment mode.

### Task 1: Add Reverse TCP Cross-Runtime Acceptance

**Files:**
- Modify: `tooling/tcp-test/localhost-loopback.mjs`
- Modify: `apps/tauri/src-tauri/src/tcp.rs`

- [ ] **Step 1: Write the failing acceptance expectation**

Add this call after `runElectronClientToTauriServer()` in the TCP harness:

```js
summaries.push(await runTauriClientToElectronServer());
```

- [ ] **Step 2: Run the TCP acceptance script and verify RED**

Run: `node tooling/tcp-test/localhost-loopback.mjs`

Expected: non-zero exit with `ReferenceError: runTauriClientToElectronServer is not defined` after the existing scenarios complete. This proves the new fourth scenario is required by the acceptance entry point.

- [ ] **Step 3: Add Rust TCP client mode**

Change the ignored contract dispatcher to an explicit three-way match:

```rust
match std::env::var("INEED_PHASE04_TCP_MODE").as_deref() {
    Ok("server") => run_phase04_tauri_server_probe(),
    Ok("client") => run_phase04_tauri_client_probe(),
    _ => run_phase04_tauri_loopback_probe(),
}
```

Add the client probe beside the existing server probe:

```rust
fn run_phase04_tauri_client_probe() {
    let port = std::env::var("INEED_PHASE04_TCP_SERVER_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let sink = Arc::new(RecordingTcpSink::default());
    let service = Arc::new(TcpService::new(sink.clone()));
    service
        .open(
            tcp_client_endpoint(
                "phase04-mixed-tauri-client",
                SocketAddr::from(([127, 0, 0, 1], port)),
            ),
            "open-mixed-tauri-client",
        )
        .unwrap();
    service
        .send("phase04-mixed-tauri-client", &[0x81, 0x82], None)
        .unwrap();
    sink.wait_for_frame("phase04-mixed-tauri-client", |frame| {
        frame.direction == "in" && frame.bytes == vec![0x91, 0x92]
    });
    service.close("phase04-mixed-tauri-client").unwrap();
    println!(
        "PHASE04_TAURI_CLIENT_RESULT={}",
        json!({
            "runtime": "tauri",
            "scenario": "tauri-client-to-electron-server",
            "frames": sink.frame_count(),
            "logs": sink.log_count(),
            "tcpLogs": sink.tcp_log_count(),
        })
    );
}
```

- [ ] **Step 4: Add Electron TCP server orchestration**

Add this harness function before `spawnManaged`:

```js
async function runTauriClientToElectronServer() {
  const { service, events } = createElectronHarness();
  let child = null;
  try {
    await service.open(tcpServerEndpoint('phase04-mixed-electron-server'), {
      operationId: 'open-mixed-electron-server',
    });
    const port = service.sessions
      .get('phase04-mixed-electron-server')
      .server.address().port;
    child = spawnManaged('cargo', [
      'test',
      '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
      'real_tcp_transport_contract',
      '--', '--ignored', '--nocapture',
    ], {
      env: {
        ...process.env,
        INEED_PHASE04_TCP_MODE: 'client',
        INEED_PHASE04_TCP_SERVER_PORT: String(port),
      },
    });
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'mixed Electron TCP server peer',
    );
    const peer = payloads(events, 'transport:peers').at(-1).peers[0];
    await waitFor(
      () => hasFrame(events, 'phase04-mixed-electron-server', 'in', [0x81, 0x82]),
      'mixed Electron TCP server inbound frame',
    );
    await service.send({
      endpointId: 'phase04-mixed-electron-server',
      peerId: peer.id,
      bytes: Uint8Array.of(0x91, 0x92),
    });
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE04_TAURI_CLIENT_RESULT=(.+)$/m);
    assert.ok(match, `Tauri mixed client did not emit a result summary:\n${output.stdout}\n${output.stderr}`);
    const tauri = JSON.parse(match[1]);
    await service.close('phase04-mixed-electron-server');
    const electronFrames = framesFor(events, 'phase04-mixed-electron-server');
    const electronLogs = logsFor(events, 'phase04-mixed-electron-server');
    assert.equal(electronFrames.every((frame) => frame.peerId === peer.id), true);
    assert.equal(electronLogs.every((log) => log.source === 'tcp'), true);
    return {
      runtime: 'mixed',
      scenario: 'tauri-client-to-electron-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: electronFrames.filter((frame) => frame.peerId === peer.id).length,
      tcpLogs: electronLogs.length,
      electron: { frames: frameCount(events), logs: logCount(events) },
      tauri,
    };
  } catch (error) {
    if (child) await terminateChild(child);
    throw error;
  } finally {
    await service.shutdown();
  }
}
```

Add `peerFrames: tauri.peerFrames` and `tcpLogs: tauri.tcpLogs` to the existing Electron-client-to-Tauri-server summary. Replace the conditional top-level assertions with:

```js
assert.equal(summaries.every((summary) => summary.peerFrames >= 2), true);
assert.equal(summaries.every((summary) => summary.tcpLogs >= 2), true);
```

- [ ] **Step 5: Run the TCP acceptance script and verify GREEN**

Run: `node tooling/tcp-test/localhost-loopback.mjs`

Expected: exit 0; `TCP_ACCEPTANCE_RESULT` contains four summaries including `tauri-client-to-electron-server`; `managedChildren` is `0`.

- [ ] **Step 6: Commit the TCP acceptance change**

```bash
git add tooling/tcp-test/localhost-loopback.mjs apps/tauri/src-tauri/src/tcp.rs
git commit -m "test: add reverse TCP runtime acceptance"
```

### Task 2: Add Reverse UDP Cross-Runtime Acceptance

**Files:**
- Modify: `tooling/udp-test/localhost-loopback.mjs`
- Modify: `apps/tauri/src-tauri/src/udp.rs`

- [ ] **Step 1: Write the failing acceptance expectation**

Add this call after `runElectronClientToTauriServer()` in the UDP harness:

```js
summaries.push(await runTauriClientToElectronServer());
```

- [ ] **Step 2: Run the UDP acceptance script and verify RED**

Run: `node tooling/udp-test/localhost-loopback.mjs`

Expected: non-zero exit with `ReferenceError: runTauriClientToElectronServer is not defined` after the existing scenarios complete.

- [ ] **Step 3: Add Rust UDP client mode**

Change the ignored contract dispatcher to:

```rust
match std::env::var("INEED_PHASE05_UDP_MODE").as_deref() {
    Ok("server") => run_phase05_tauri_server_probe(),
    Ok("client") => run_phase05_tauri_client_probe(),
    _ => run_phase05_tauri_loopback_probe(),
}
```

Add the client probe beside the existing server probe:

```rust
fn run_phase05_tauri_client_probe() {
    let port = std::env::var("INEED_PHASE05_UDP_SERVER_PORT")
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let sink = Arc::new(RecordingUdpSink::default());
    let service = Arc::new(UdpService::new(sink.clone()));
    service
        .open(
            udp_client_endpoint(
                "phase05-mixed-tauri-client",
                SocketAddr::from(([127, 0, 0, 1], port)),
            ),
            "open-mixed-tauri-client",
        )
        .unwrap();
    service
        .send("phase05-mixed-tauri-client", &[0x81, 0x82], None)
        .unwrap();
    sink.wait_for_frame("phase05-mixed-tauri-client", |frame| {
        frame.direction == "in" && frame.bytes == vec![0x91, 0x92]
    });
    service.close("phase05-mixed-tauri-client").unwrap();
    println!(
        "PHASE05_TAURI_CLIENT_RESULT={}",
        json!({
            "runtime": "tauri",
            "scenario": "tauri-client-to-electron-server",
            "frames": sink.frame_count(),
            "logs": sink.log_count(),
            "udpLogs": sink.udp_log_count(),
        })
    );
}
```

- [ ] **Step 4: Add Electron UDP server orchestration**

Add this function before `bindSocket`:

```js
async function runTauriClientToElectronServer() {
  const { service, events } = createElectronHarness();
  let child = null;
  try {
    await service.open(udpServerEndpoint('phase05-mixed-electron-server'), {
      operationId: 'open-mixed-electron-server',
    });
    const port = service.sessions
      .get('phase05-mixed-electron-server')
      .socket.address().port;
    child = spawnManaged('cargo', [
      'test',
      '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
      'real_udp_transport_contract',
      '--', '--ignored', '--nocapture',
    ], {
      env: {
        ...process.env,
        INEED_PHASE05_UDP_MODE: 'client',
        INEED_PHASE05_UDP_SERVER_PORT: String(port),
      },
    });
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'mixed Electron UDP server peer',
    );
    const peer = payloads(events, 'transport:peers').at(-1).peers[0];
    await waitFor(
      () => hasFrame(events, 'phase05-mixed-electron-server', 'in', [0x81, 0x82]),
      'mixed Electron UDP server inbound frame',
    );
    await service.send({
      endpointId: 'phase05-mixed-electron-server',
      bytes: Uint8Array.of(0x91, 0x92),
      target: { peerId: peer.id },
    });
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE05_TAURI_CLIENT_RESULT=(.+)$/m);
    assert.ok(match, `Tauri mixed UDP client did not emit a result summary:\n${output.stdout}\n${output.stderr}`);
    const tauri = JSON.parse(match[1]);
    await service.close('phase05-mixed-electron-server');
    const electronFrames = framesFor(events, 'phase05-mixed-electron-server');
    const electronLogs = logsFor(events, 'phase05-mixed-electron-server');
    assert.equal(electronFrames.every((frame) => frame.peerId === peer.id), true);
    assert.equal(electronLogs.every((log) => log.source === 'udp'), true);
    return {
      runtime: 'mixed',
      scenario: 'tauri-client-to-electron-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: electronFrames.filter((frame) => frame.peerId === peer.id).length,
      udpLogs: electronLogs.length,
      electron: { frames: frameCount(events), logs: logCount(events) },
      tauri,
    };
  } catch (error) {
    if (child) await terminateChild(child);
    throw error;
  } finally {
    await service.shutdown();
  }
}
```

Add `peerFrames: tauri.peerFrames` and `udpLogs: tauri.udpLogs` to the existing Electron-client-to-Tauri-server summary. The new function above derives those fields from Electron server frame peer IDs and `udp` logs. Then use these uniform assertions:

```js
assert.equal(summaries.every((summary) => summary.peerFrames >= 2), true);
assert.equal(summaries.every((summary) => summary.udpLogs >= 2), true);
```

- [ ] **Step 5: Run the UDP acceptance script and verify GREEN**

Run: `node tooling/udp-test/localhost-loopback.mjs`

Expected: exit 0; `UDP_ACCEPTANCE_RESULT` contains four summaries including `tauri-client-to-electron-server`; `managedChildren` is `0`.

- [ ] **Step 6: Commit the UDP acceptance change**

```bash
git add tooling/udp-test/localhost-loopback.mjs apps/tauri/src-tauri/src/udp.rs
git commit -m "test: add reverse UDP runtime acceptance"
```

### Task 3: Run Full Verification

**Files:**
- Verify only: all files changed by Tasks 1 and 2

- [ ] **Step 1: Format and inspect changed sources**

Run: `cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml -- --check`

Expected: exit 0.

Run: `git diff --check HEAD~2..HEAD`

Expected: exit 0 with no output.

- [ ] **Step 2: Run the complete phase verification**

Run: `npm run verify:phase-05`

Expected: exit 0 with all Node, Vitest, Rust, Playwright, serial, TCP, and UDP checks passing. TCP and UDP result lines each contain four summaries and `managedChildren: 0`.

- [ ] **Step 3: Confirm repository and process state**

Run: `git status --short`

Expected: no output.

Run: `pgrep -af '/Users/pangzhigang/develop/com.ineedfull/ineed-dev-tool'`

Expected: no persistent Vite, Electron, Cargo test, or acceptance child process owned by this repository.
