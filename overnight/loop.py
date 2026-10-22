#!/usr/bin/env python3
"""Overnight loop: run Claude Code (opus 5.5, high effort) against hermes-duet until a deadline.

Each iteration: build a prompt from BRIEF_LOOP.md + BACKLOG.md + JOURNAL tail, run `claude-api -p`,
gate on typecheck/test/build, commit on green, revert on red, journal the result.
The loop never pushes, never restarts the service, and stops at the deadline or on a STOP file.
"""
import os, subprocess, sys, time, datetime, pathlib, json, shutil

REPO = pathlib.Path("/Users/devgwardo/hermes-duet")
STATE = REPO / "overnight"
LOGS = STATE / "logs"
LAUNCHER = pathlib.Path("/Users/devgwardo/.local/bin/claude-api")
MODEL = "claude-opus-5-5"
EFFORT = "high"
ITER_TIMEOUT = 2100          # 35 min per iteration, hard
GATE_TIMEOUT = 900
MAX_CONSECUTIVE_FAILS = 3
SLEEP_BETWEEN = 20

def now():
    return datetime.datetime.now()

def log(msg):
    line = f"[{now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with open(STATE / "loop.log", "a") as f:
        f.write(line + "\n")

def run(cmd, timeout, cwd=REPO):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)

def tail(text, n=1200):
    text = (text or "").strip()
    return text[-n:] if len(text) > n else text

def gate():
    """typecheck + unit tests + build. Returns (ok, report)."""
    report = []
    ok = True
    for label, cmd in (("typecheck", ["bun", "run", "typecheck"]),
                       ("test", ["bun", "test"]),
                       ("build", ["bun", "run", "build"])):
        try:
            r = run(cmd, GATE_TIMEOUT)
            passed = r.returncode == 0
            report.append(f"{label}: exit {r.returncode}")
            report.append(tail(r.stdout or "", 400))
            if not passed:
                report.append(tail(r.stderr or "", 700))
                ok = False
                break
        except subprocess.TimeoutExpired:
            report.append(f"{label}: TIMEOUT after {GATE_TIMEOUT}s")
            ok = False
            break
    return ok, "\n".join(x for x in report if x)

def build_prompt(iteration):
    brief = (STATE / "BRIEF_LOOP.md").read_text()
    backlog = (STATE / "BACKLOG.md").read_text()
    journal_path = STATE / "JOURNAL.md"
    journal = journal_path.read_text() if journal_path.exists() else "(empty — this is the first iteration)"
    recent = "\n".join(journal.splitlines()[-120:])
    return (
        f"{brief}\n\n---\n\n# Iteration {iteration} — {now():%Y-%m-%d %H:%M %Z}\n\n"
        f"## overnight/BACKLOG.md (current)\n\n{backlog}\n\n"
        f"## overnight/JOURNAL.md (most recent entries)\n\n{recent}\n\n"
        "Do the single next unchecked, unblocked backlog item now. Follow the protocol in the "
        "brief above, and finish with the short `DONE:`/`BLOCKED:` answer shape.\n"
    )

def commit(iteration, answer):
    title = "overnight iteration"
    for line in (answer or "").splitlines():
        if line.startswith("DONE:") or line.startswith("BLOCKED:"):
            title = line[:110]
            break
    run(["git", "add", "-A"], 120)
    r = run(["git", "commit", "-m", f"overnight(iter {iteration}): {title}"], 120)
    return r.returncode == 0, tail((r.stdout or "") + (r.stderr or ""), 300)

def revert():
    run(["git", "checkout", "--", "."], 180)
    run(["git", "clean", "-fd", "server", "web/src", "shared"], 180)

def deadline_for(hhmm):
    h, m = (int(x) for x in hhmm.split(":"))
    d = now().replace(hour=h, minute=m, second=0, microsecond=0)
    if d <= now():
        d += datetime.timedelta(days=1)
    return d

def main():
    deadline = deadline_for(sys.argv[1] if len(sys.argv) > 1 else "06:00")
    LOGS.mkdir(parents=True, exist_ok=True)
    log(f"loop start · model={MODEL} effort={EFFORT} · deadline {deadline:%Y-%m-%d %H:%M}")

    # branch (never main), from a clean tree
    branch = f"overnight/claude-duet-{deadline:%Y%m%d}"
    cur = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], 30).stdout.strip()
    if cur != branch:
        existing = run(["git", "rev-parse", "--verify", branch], 30).returncode == 0
        r = run(["git", "checkout", branch] if existing else ["git", "checkout", "-b", branch], 60)
        if r.returncode != 0:
            log(f"FATAL cannot switch to {branch}: {tail(r.stderr,300)}")
            return 2
    log(f"branch={branch}")

    consecutive = 0
    iteration = 0
    while now() < deadline:
        if (STATE / "STOP").exists():
            log("STOP file present — exiting")
            break
        iteration += 1
        stamp = f"{now():%Y%m%d-%H%M%S}"
        log_path = LOGS / f"iter-{iteration:02d}-{stamp}.log"
        prompt = build_prompt(iteration)
        log(f"iter {iteration} start → {log_path.name}")

        try:
            with open(log_path, "w") as fh:
                proc = subprocess.run(
                    [str(LAUNCHER), "-p", "--model", MODEL, "--effort", EFFORT,
                     "--permission-mode", "acceptEdits",
                     "--allowedTools=Bash,Read,Edit,Write,Glob,Grep"],
                    input=prompt, cwd=str(REPO), stdout=fh, stderr=subprocess.STDOUT,
                    timeout=ITER_TIMEOUT)
            answer = log_path.read_text()
            exit_code = proc.returncode
        except subprocess.TimeoutExpired:
            answer, exit_code = f"BLOCKED: iteration timed out after {ITER_TIMEOUT}s", 124
            log(f"iter {iteration} TIMEOUT")

        diff = run(["git", "status", "--porcelain"], 60).stdout.strip()
        changed = [l for l in diff.splitlines() if not l.endswith("overnight/loop.log")]

        ok, report = gate() if changed else (True, "no code changes")
        committed = False
        if changed and ok:
            committed, msg = commit(iteration, answer)
            log(f"iter {iteration} commit={'ok' if committed else 'FAILED'} {msg}")
        elif changed:
            log(f"iter {iteration} gate RED → revert")
            revert()

        ok_run = (exit_code == 0 and ok)
        consecutive = 0 if ok_run else consecutive + 1
        if ok_run and not changed:
            consecutive = 0

        with open(STATE / "JOURNAL.md", "a") as f:
            f.write(f"\n## {now():%Y-%m-%dT%H:%M:%SZ} — loop iteration {iteration}\n"
                    f"- exit={exit_code} gate={'green' if ok else 'red'} committed={committed} "
                    f"files={len(changed)}\n"
                    f"- gate report: {report.splitlines()[0] if report else 'n/a'}\n"
                    f"- answer:\n```\n{tail(answer, 1500)}\n```\n")

        log(f"iter {iteration} done · exit={exit_code} gate={'green' if ok else 'red'} "
            f"committed={committed} changed={len(changed)} fails={consecutive}")

        if consecutive >= MAX_CONSECUTIVE_FAILS:
            log(f"{consecutive} consecutive failures — stopping")
            break
        time.sleep(SLEEP_BETWEEN)

    log("loop finished")
    return 0

if __name__ == "__main__":
    sys.exit(main())