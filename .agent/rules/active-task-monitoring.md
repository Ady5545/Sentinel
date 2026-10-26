# Active Background Task Monitoring & Windows Process Supervision

## Scope & Intent
This rule enforces proactive supervision over any asynchronous background commands, test runs, dev servers, and audit tasks. It prevents unobserved hangs, orphaned child processes, and dormant chat states.

---

## 1. Proactive Monitoring Protocol
1. **Never Assume Silent Completion:** When a background command or task is running, do not remain idle indefinitely waiting for automatic wakeup notifications.
2. **Periodic Status Checks:** If an asynchronous command exceeds its expected completion window (or after completing any intervening work), proactively check task health using:
   - `manage_task` with `Action: "status"` and the relevant `TaskId`.
3. **Inspect Progress & Logs:** Read recent log lines. If the task has completed its work (e.g. printed completion banners, finished tests) but failed to exit, inspect why and immediately terminate the task.
4. **Use Timer / Schedule Wakeups When Needed:** When launching tasks expected to take >30 seconds, schedule a verification timer via `schedule` to guarantee prompt follow-up.

---

## 2. Windows Subprocess Termination Invariant
1. **Tree-Kill Requirement:** On Windows systems, sub-processes spawned via shells (`shell: true` or npm/npx wrappers) often orphan child processes if only the parent is killed.
2. **Explicit Exit in Scripts:** Any custom runner or audit script that starts a local preview/dev server must:
   - Call `process.exit(0)` after finishing its primary workload.
   - Use Windows taskkill (`taskkill /pid <PID> /T /F`) or graceful socket shutdown to ensure all child servers are completely terminated.

---

## 3. Immediate Action on Stuck Tasks
- If a task shows no progress, high CPU with no output, or port conflict loops, report the finding to the user with the relevant log snippet, terminate the stuck task via `manage_task(Action: "kill")`, and re-execute with targeted fixes.
---

## 4. Local Server & Port Invariants
1. **Detect Port Shadowing:** When launching local preview or production servers, verify whether the canonical default port (e.g. 3000) is in use by an external or stale process before launching on fallback ports.
2. **Release Stale Listeners:** If an existing process occupies port 3000 from a parent repository or older task, terminate the old listener or clearly bind and point the user to the active port without ambiguity.
