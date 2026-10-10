#!/usr/bin/env bash
# Scaffold all Flint crate manifests + stub entrypoints.
set -euo pipefail
cd /home/z/my-project/flint/crates

# ---------- flint-journal ----------
cat > flint-journal/Cargo.toml <<'EOF'
[package]
name = "flint-journal"
description = "Crash-consistent WAL, replayable FS op-log, snapshot manifests and layer packer"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
crc32fast = { workspace = true }
sha2 = { workspace = true }
hex = { workspace = true }
tar = { workspace = true }
flate2 = { workspace = true }
uuid = { workspace = true }
chrono = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
EOF
echo "// journal" > flint-journal/src/lib.rs

# ---------- flint-store ----------
cat > flint-store/Cargo.toml <<'EOF'
[package]
name = "flint-store"
description = "SQLite metadata store, object store (local + S3-compatible) and routing table"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
rusqlite = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
uuid = { workspace = true }
hmac = { workspace = true }
sha2 = { workspace = true }
hex = { workspace = true }
base64 = { workspace = true }
ureq = { workspace = true }
chrono = { workspace = true }
anyhow = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
EOF
echo "// store" > flint-store/src/lib.rs

# ---------- flint-net ----------
cat > flint-net/Cargo.toml <<'EOF'
[package]
name = "flint-net"
description = "Per-sandbox network slots: netns + veth + TAP provisioning, IPAM, egress policy"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
anyhow = { workspace = true }
EOF
echo "// net" > flint-net/src/lib.rs

# ---------- flint-vm ----------
cat > flint-vm/Cargo.toml <<'EOF'
[package]
name = "flint-vm"
description = "VmDriver trait, Firecracker microVM driver (UDS API + jailer + snapshots), dev ProcessDriver, guest-agent client"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
flint-journal = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }
async-stream = { workspace = true }
futures = { workspace = true }
uuid = { workspace = true }
nix = { workspace = true }
libc = { workspace = true }
bytes = { workspace = true }
hyper = { workspace = true }
hyper-util = { workspace = true }
http-body-util = { workspace = true }
anyhow = { workspace = true }
rand = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
EOF
echo "// vm" > flint-vm/src/lib.rs

# ---------- flint-proto ----------
cat > flint-proto/Cargo.toml <<'EOF'
[package]
name = "flint-proto"
description = "Protobuf + tonic codegen for the public gRPC API and the fleet protocol"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
tonic = { workspace = true }
prost = { workspace = true }
serde = { workspace = true }

[build-dependencies]
tonic-build = { workspace = true }
protoc-bin-vendored = { workspace = true }
EOF
echo "// proto" > flint-proto/src/lib.rs

# ---------- flint-scheduler ----------
cat > flint-scheduler/Cargo.toml <<'EOF'
[package]
name = "flint-scheduler"
description = "Fleet placement (best-of-K + jitter), worker registry, warm pools"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
rand = { workspace = true }
anyhow = { workspace = true }
EOF
echo "// scheduler" > flint-scheduler/src/lib.rs

# ---------- flint-tools ----------
cat > flint-tools/Cargo.toml <<'EOF'
[package]
name = "flint-tools"
description = "Agent tool gateway: web search providers, http_fetch, quota-enforced"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tokio = { workspace = true }
ureq = { workspace = true }
chrono = { workspace = true }
anyhow = { workspace = true }
EOF
echo "// tools" > flint-tools/src/lib.rs

# ---------- flint-guest-agent ----------
cat > flint-guest-agent/Cargo.toml <<'EOF'
[package]
name = "flint-guest-agent"
description = "In-sandbox agent: exec/PTY, files, process supervision, journal mirroring (vsock + TCP)"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
flint-core = { workspace = true }
flint-journal = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }
futures = { workspace = true }
nix = { workspace = true }
libc = { workspace = true }
anyhow = { workspace = true }
clap = { workspace = true }
EOF
cat > flint-guest-agent/src/main.rs <<'EOF'
fn main() {}
EOF

# ---------- flint-worker ----------
cat > flint-worker/Cargo.toml <<'EOF'
[package]
name = "flint-worker"
description = "Node daemon: sandbox supervision, journaling, snapshots, fleet gRPC (server + client)"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "flint-worker"
path = "src/main.rs"

[dependencies]
flint-core = { workspace = true }
flint-journal = { workspace = true }
flint-store = { workspace = true }
flint-net = { workspace = true }
flint-vm = { workspace = true }
flint-proto = { workspace = true }
flint-tools = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }
futures = { workspace = true }
async-stream = { workspace = true }
uuid = { workspace = true }
chrono = { workspace = true }
anyhow = { workspace = true }
clap = { workspace = true }
tonic = { workspace = true }
rand = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
EOF
cat > flint-worker/src/main.rs <<'EOF'
fn main() {}
EOF

# ---------- flint-gateway ----------
cat > flint-gateway/Cargo.toml <<'EOF'
[package]
name = "flint-gateway"
description = "Control plane: REST + WebSocket + gRPC, auth, quotas, scheduling, routing, preview proxy"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "flint-gateway"
path = "src/main.rs"

[dependencies]
flint-core = { workspace = true }
flint-journal = { workspace = true }
flint-store = { workspace = true }
flint-vm = { workspace = true }
flint-proto = { workspace = true }
flint-scheduler = { workspace = true }
flint-tools = { workspace = true }
axum = { workspace = true }
tower = { workspace = true }
tower-http = { workspace = true }
hyper = { workspace = true }
hyper-util = { workspace = true }
http-body-util = { workspace = true }
tokio = { workspace = true }
tokio-stream = { workspace = true }
async-stream = { workspace = true }
futures = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
uuid = { workspace = true }
chrono = { workspace = true }
anyhow = { workspace = true }
clap = { workspace = true }
tonic = { workspace = true }
bytes = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
EOF
cat > flint-gateway/src/main.rs <<'EOF'
fn main() {}
EOF

# ---------- flint-cli ----------
cat > flint-cli/Cargo.toml <<'EOF'
[package]
name = "flint-cli"
description = "Human-friendly CLI for the Flint platform"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "flint"
path = "src/main.rs"

[dependencies]
flint-core = { workspace = true }
flint-proto = { workspace = true }
clap = { workspace = true }
tokio = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
anyhow = { workspace = true }
thiserror = { workspace = true }
ureq = { workspace = true }
base64 = { workspace = true }
tracing-subscriber = { workspace = true }
EOF
cat > flint-cli/src/main.rs <<'EOF'
fn main() {}
EOF

echo "all crate manifests written"
