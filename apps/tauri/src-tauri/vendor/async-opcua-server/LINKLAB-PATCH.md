# LinkLab maintained patch

Source: crates.io async-opcua-server 0.19.0, https://github.com/freeopcua/async-opcua .
Upstream source notices and MPL-2.0 license are retained.

The subscription scheduler previously drained a monitored item before its deferred
sample was due. If no later writes arrived, the final value remained pending and
never reached the subscriber, although a direct Read returned the new value.

Behavior changes are limited to `src/subscriptions/monitored_item.rs` (private pending
sample and deadline queries) and `src/subscriptions/subscription.rs` (schedule deferred item IDs separately
from ready notifications, plus deterministic final-value, keepalive and cleanup regressions). No new sampling rate, value,
security, queue or wire behavior is configured. Item IDs leave the scheduled set
when the pending sample has been delivered or the item is removed/replaced.
Future samples do not suppress keepalives, including during repeated early writes.

The Rust root workspace registers this package to run its unit regressions with
the product's locked dependency graph. Default members remain the desktop root;
existing product commands retain their scope.

The vendored `src/session/manager.rs` also removes one upstream trailing space
to pass the staged Git whitespace check; its executable behavior is unchanged.

Verification from the product repository:

```sh
cargo test --offline --manifest-path apps/tauri/src-tauri/Cargo.toml -p async-opcua-server subscriptions:: -- --test-threads=1
cargo build --offline --manifest-path apps/tauri/src-tauri/Cargo.toml --bin opcua-harness
node apps/tauri/src-tauri/tests/opcua-server-native-local.mjs
```

The native regression performs 25 bursts of rapid writes and verifies that the
last subscribed value arrives without another write, as well as direct readback.
Remove this patch after the selected upstream release passes both regressions.

The full upstream library suite also references `../samples/server.conf`, which
crates.io does not include. That fixture test remains a documented upstream
packaging limitation; the subscription module suite is runnable without it.
