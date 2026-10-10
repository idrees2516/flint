#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────
# Flint · Persistent Python Kernel (prime-agent RLM parity)
#
# A long-lived CPython process that keeps a persistent __main__
# namespace across turns. The TS host (KernelManager) speaks
# NDJSON over stdin/stdout-dup:
#
#   host → kernel (stdin):
#     {"op":"ping","id":...}
#     {"op":"eval","id":...,"code":"...","timeoutMs":...}
#     {"op":"host_result","hid":...,"ok":true,"result":...}
#     {"op":"snapshot","id":...}
#     {"op":"restore","id":...,"blob":"<base64 pickle>"}
#     {"op":"vars","id":...}
#     {"op":"shutdown"}
#
#   kernel → host (real stdout):
#     {"ch":"result","id":...,"ok":...,"result":...,"stdout":...,
#      "stderr":...,"durationMs":...}
#     {"ch":"host_call","hid":...,"fn":"websearch","args":[...]}
#     {"ch":"snapshot","id":...,"ok":...,"blob":...,"manifest":...}
#     {"ch":"vars","id":...,"vars":{name: repr}}
#     {"ch":"log","level":...,"message":...}
#
# Tool functions injected into the kernel namespace:
#   bash(cmd)            → BashHandle (background, non-blocking)
#   edit(path, old, new) → exact-unique-match file edit
#   read(path)           → file contents
#   write(path, content) → write file
#   host(fn, *args)      → call a HOST-side tool (websearch,
#                          spawn, mcp, ...) — blocks on reply
# ─────────────────────────────────────────────────────────────
import base64
import io
import json
import os
import pickle
import subprocess
import sys
import threading
import time
import traceback
import types

REAL_STDOUT = os.dup(1)  # protocol channel (survives stdout swap)
WORKDIR = os.environ.get("FLINT_KERNEL_CWD") or os.getcwd()

# ── protocol writer ─────────────────────────────────────────
_wlock = threading.Lock()

def send(obj: dict) -> None:
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _wlock:
        os.write(REAL_STDOUT, (line + "\n").encode("utf-8", "replace"))

def log(message: str, level: str = "info") -> None:
    send({"ch": "log", "level": level, "message": str(message)[:2000]})

# ── host bridge: kernel-side blocking host tool calls ───────
class HostCaller:
    def __init__(self):
        self._seq = 0
        self._pending = {}  # hid → {"event":Event,"result":...}

    def call(self, fn: str, *args, timeout: float = 120.0):
        self._seq += 1
        hid = f"h{self._seq}"
        ev = threading.Event()
        self._pending[hid] = {"event": ev, "result": None}
        send({"ch": "host_call", "hid": hid, "fn": fn, "args": list(args)})
        if not ev.wait(timeout):
            del self._pending[hid]
            raise TimeoutError(f"host call {fn}() timed out after {timeout}s")
        entry = self._pending.pop(hid)
        r = entry["result"]
        if r.get("ok") is False:
            raise RuntimeError(f"host {fn}() error: {r.get('error')}")
        return r.get("result")

    def resolve(self, hid: str, ok: bool, result=None, error=None):
        entry = self._pending.get(hid)
        if entry is None:
            return
        entry["result"] = {"ok": ok, "result": result, "error": error}
        entry["event"].set()

HOST = HostCaller()

def host(fn: str, *args, **kwargs):
    """Call a host-side tool (websearch, spawn, mcp, ...) from kernel code."""
    return HOST.call(fn, *args, **kwargs)

# ── background bash handles ─────────────────────────────────
class BashHandle:
    """Non-blocking background shell execution with a live handle."""

    def __init__(self, cmd: str):
        self.command = cmd
        self.pid = 0
        self._started = time.time()
        self._proc = subprocess.Popen(
            ["bash", "-c", cmd],
            cwd=WORKDIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        self.pid = self._proc.pid

    @property
    def running(self) -> bool:
        return self._proc.poll() is None

    def poll(self):
        """Return exit code if finished, else None."""
        return self._proc.poll()

    def output(self, timeout: float = 0.0) -> str:
        """Full collected output. Waits up to `timeout` for completion."""
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            pass
        out = ""
        if self._proc.stdout is not None:
            if self._proc.poll() is not None:
                # finished — blocking read is safe
                try:
                    out = self._proc.stdout.read()
                except Exception:
                    out = ""
            else:
                # still running — non-blocking drain
                try:
                    os.set_blocking(self._proc.stdout.fileno(), False)
                    chunks = []
                    while True:
                        chunk = self._proc.stdout.read()
                        if not chunk:
                            break
                        chunks.append(chunk)
                    out = "".join(chunks)
                except Exception:
                    out = ""
        return f"$ {self.command}\n{out}\n[exit {self._proc.poll()} · {time.time()-self._started:.1f}s]"

    def tail(self, n: int = 40) -> str:
        """Last n lines of current output (non-blocking)."""
        out = self.output(0)
        return "\n".join(out.splitlines()[-n:])

    def kill(self) -> str:
        if self.running:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        return f"killed [{self.command[:60]}] exit={self._proc.poll()}"

    def __repr__(self):
        status = "running" if self.running else f"exit {self._proc.poll()}"
        return f"<BashHandle {status}: {self.command[:60]}>"

_BASH_BLOCKLIST = (
    "rm -rf /", "mkfs", "dd if=/dev/", "shutdown", "reboot", ":(){:|:&};:",
)

def bash(cmd: str) -> BashHandle:
    """Run a shell command in the background. Returns a BashHandle."""
    if not isinstance(cmd, str) or not cmd.strip():
        raise ValueError("bash(command) requires a non-empty string")
    for bad in _BASH_BLOCKLIST:
        if bad in cmd:
            raise ValueError(f"blocked by sandbox policy: {cmd[:80]}")
    return BashHandle(cmd)

# ── file tools ──────────────────────────────────────────────
def _abs(p: str) -> str:
    return p if os.path.isabs(p) else os.path.join(WORKDIR, p)

def read(path: str) -> str:
    """Read a text file (relative to workspace)."""
    with open(_abs(path), "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def write(path: str, content: str) -> str:
    """Write a text file (relative to workspace)."""
    p = _abs(path)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return f"wrote {path} ({len(content)} bytes)"

def edit(path: str, old_str: str, new_str: str) -> str:
    """Exact-unique-match string replacement in a file."""
    p = _abs(path)
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    n = content.count(old_str)
    if n == 0:
        raise ValueError(f"edit: old_str not found in {path}")
    if n > 1:
        raise ValueError(f"edit: old_str matches {n} locations in {path} — make it unique")
    with open(p, "w", encoding="utf-8") as f:
        f.write(content.replace(old_str, new_str, 1))
    return f"edited {path} ({len(old_str)} → {len(new_str)} chars)"

def ls(path: str = ".") -> str:
    """List a directory (maxdepth 2)."""
    out = []
    base = _abs(path)
    for root, dirs, files in os.walk(base):
        depth = root[len(base):].count(os.sep)
        if depth >= 2:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for d in dirs:
            out.append(os.path.relpath(os.path.join(root, d), base) + "/")
        for f in files:
            out.append(os.path.relpath(os.path.join(root, f), base))
        out.sort()
    return "\n".join(out[:400]) or "(empty)"

# ── persistent namespace ────────────────────────────────────
NS = {"__name__": "__main__", "__builtins__": __builtins__}

def _inject_tools() -> None:
    NS.update(
        bash=bash, read=read, write=write, edit=edit, ls=ls, host=host,
        websearch=lambda q, num=5: host("websearch", q, num),
        flint_done=lambda summary="": host("done", summary),
    )

_inject_tools()

# ── eval with stdout capture ────────────────────────────────
import ast

def eval_code(code: str) -> dict:
    t0 = time.time()
    buf_out, buf_err = io.StringIO(), io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = buf_out, buf_err
    try:
        result = None
        tree = ast.parse(code, "<flint-kernel>")
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            # REPL semantics: echo the value of a trailing expression
            last_expr = ast.Expression(tree.body[-1].value)
            tree.body.pop()
            if tree.body:
                exec(compile(tree, "<flint-kernel>", "exec"), NS)  # type: ignore[arg-type]
            result = eval(compile(last_expr, "<flint-kernel>", "eval"), NS)  # type: ignore[arg-type]
        else:
            exec(compile(tree, "<flint-kernel>", "exec"), NS)  # type: ignore[arg-type]
        ok = True
        if result is not None:
            try:
                buf_out.write(repr(result) + "\n")
            except Exception:
                buf_out.write(f"<unrepresentable: {type(result).__name__}>\n")
    except BaseException:
        ok = False
        err = traceback.format_exc(limit=8)
        buf_err.write(err)
        result = None
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    return {
        "ok": ok,
        "stdout": buf_out.getvalue()[-16000:],
        "stderr": buf_err.getvalue()[-8000:],
        "durationMs": int((time.time() - t0) * 1000),
    }

# ── snapshot / restore (per-variable pickling, byte caps) ───
MAX_VAR_BYTES = 4 * 1024 * 1024  # 4 MiB per variable

def snapshot() -> dict:
    manifest, keep = {}, {}
    for k, v in list(NS.items()):
        if k.startswith("__"):
            continue
        if isinstance(v, type) or isinstance(v, types.ModuleType):
            continue
        if getattr(v, "__module__", "") == "__main__" and callable(v) and not hasattr(v, "__self__"):
            # functions defined in-kernel: skip pickling but note them
            manifest[k] = {"skipped": True, "reason": "function"}
            continue
        try:
            blob = pickle.dumps(v)
            if len(blob) > MAX_VAR_BYTES:
                manifest[k] = {"skipped": True, "reason": f"too large ({len(blob)} bytes)"}
                continue
            keep[k] = blob
            manifest[k] = {"bytes": len(blob), "type": type(v).__name__}
        except Exception as e:
            manifest[k] = {"skipped": True, "reason": f"unpicklable: {type(e).__name__}"}
    payload = pickle.dumps(keep)
    return {
        "blob": base64.b64encode(payload).decode("ascii"),
        "manifest": manifest,
    }

def restore(blob_b64: str) -> dict:
    try:
        keep = pickle.loads(base64.b64decode(blob_b64))
        restored = []
        for k, blob in keep.items():
            try:
                NS[k] = pickle.loads(blob)
                restored.append(k)
            except Exception:
                pass
        _inject_tools()
        return {"ok": True, "restored": restored}
    except Exception as e:
        return {"ok": False, "error": f"restore failed: {e}"}

def list_vars() -> dict:
    out = {}
    for k, v in NS.items():
        if k.startswith("__"):
            continue
        try:
            out[k] = repr(v)[:120]
        except Exception:
            out[k] = "<unrepresentable>"
    return out

# ── stdin reader loop ───────────────────────────────────────
def handle_line(line: str) -> None:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        log(f"bad json: {line[:100]}", "warn")
        return
    op = msg.get("op")
    if op == "ping":
        send({"ch": "result", "id": msg.get("id"), "ok": True, "result": "pong", "stdout": "", "stderr": "", "durationMs": 0})
    elif op == "eval":
        res = eval_code(msg.get("code", ""))
        send({"ch": "result", "id": msg.get("id"), **res})
    elif op == "host_result":
        HOST.resolve(msg.get("hid"), msg.get("ok", False), msg.get("result"), msg.get("error"))
    elif op == "snapshot":
        snap = snapshot()
        send({"ch": "snapshot", "id": msg.get("id"), "ok": True, **snap})
    elif op == "restore":
        res = restore(msg.get("blob", ""))
        send({"ch": "result", "id": msg.get("id"), **res})
    elif op == "vars":
        send({"ch": "vars", "id": msg.get("id"), "ok": True, "vars": list_vars()})
    elif op == "shutdown":
        log("kernel shutting down")
        os._exit(0)
    else:
        log(f"unknown op: {op}", "warn")

def main() -> None:
    send({"ch": "log", "level": "info", "message": f"flint-kernel ready · python {sys.version.split()[0]} · cwd={WORKDIR}"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            probe = json.loads(line)
        except json.JSONDecodeError:
            continue
        if probe.get("op") == "host_result":
            # resolve immediately on the reader thread — unblocks evals
            handle_line(line)
            continue
        # everything else runs on a worker thread so host_result lines
        # are never starved by long-running evals
        threading.Thread(target=handle_line, args=(line,), daemon=True).start()

if __name__ == "__main__":
    main()
