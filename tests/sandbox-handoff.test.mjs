import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { approvePlan, createSnapshot, executePlan, handoffStatus, importPlan, readHandoffArtifact, rejectPlan, validatePlan } from "../scripts/handoff-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "scripts", "sandbox-handoff.mjs");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-handoff-"));
  const repository = path.join(root, "repository");
  const state = path.join(root, "state");
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "sandbox-handoff@example.invalid"]);
  git(repository, ["config", "user.name", "Sandbox Handoff Test"]);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);
  return { root, repository, state };
}

function contractFor(snapshot, taskId, repository) {
  return {
    schema_version: "web_pro_codex_task_contract.v1",
    task_id: taskId,
    repository,
    branch: snapshot.branch,
    snapshot: { ...snapshot },
    planner: { surface: "web_pro", context_mode: "read_only_snapshot" },
    goal: ["Create the requested local change."],
    non_goals: ["Do not merge, push, deploy, or produce final acceptance."],
    allowed_paths: ["result.txt"],
    forbidden_paths: ["README.md", "**/.git/**"],
    validation_commands: ["test -f result.txt"],
    required_artifacts: ["EXECUTION_RECEIPT.json", "commands.jsonl", "test_results.json", "diff_manifest.json"],
    stop_conditions: ["Stop if the snapshot is stale or a path is outside the allowlist."],
    pass_gates: ["Codex exits zero and the requested validation passes."],
    executor: { sandbox: "workspace-write" }
  };
}

function cli(state, args) {
  const output = execFileSync(process.execPath, [cliPath, ...args, "--state-root", state], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output);
}

function cleanup(fixture, worktree = null) {
  if (worktree && fs.existsSync(worktree)) {
    try { git(fixture.repository, ["worktree", "remove", "--force", worktree]); } catch { /* fixture cleanup */ }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("CLI imports, validates, approves, executes in a fresh worktree, and exposes receipt artifacts", async () => {
  const fixture = makeFixture();
  let worktree = null;
  try {
    const snapshotResult = cli(fixture.state, ["snapshot", "--root", fixture.repository]);
    const snapshot = { ...snapshotResult };
    delete snapshot.ok;
    delete snapshot.path;
    assert.match(snapshot.snapshot_id, /^snapshot_[0-9a-f]{32}$/);
    assert.match(snapshot.base_commit, /^[0-9a-f]{40}$/);
    assert.match(snapshot.tree_hash, /^[0-9a-f]{40}$/);
    assert.equal(snapshot.dirty, false);

    const planPath = path.join(fixture.root, "task-contract.json");
    fs.writeFileSync(planPath, `${JSON.stringify(contractFor(snapshot, "task-cli", fixture.repository), null, 2)}\n`);
    const imported = cli(fixture.state, ["import-plan", "--file", planPath]);
    assert.equal(imported.ok, true);
    assert.equal(imported.status, "imported");
    assert.match(imported.plan_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(cli(fixture.state, ["validate", "--task-id", "task-cli"]).status, "PASS");
    assert.equal(cli(fixture.state, ["approve", "--task-id", "task-cli", "--yes"]).status, "approved");

    const fakeCodex = path.join(fixture.root, "fake-codex");
    fs.writeFileSync(fakeCodex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake-codex-1.0; exit 0; fi\nprintf 'generated\\n' > result.txt\necho executor-finished\n");
    fs.chmodSync(fakeCodex, 0o700);
    const executed = cli(fixture.state, ["execute", "--task-id", "task-cli", "--yes", "--run-validation", "--codex-bin", fakeCodex]);
    assert.equal(executed.ok, true);
    assert.equal(executed.status, "completed");
    assert.equal(executed.acceptance_verdict, "not_produced_by_executor");
    assert.deepEqual(executed.unexpected_modified_paths, []);
    worktree = executed.worktree.path;
    assert.equal(fs.readFileSync(path.join(worktree, "result.txt"), "utf8"), "generated\n");

    const receipt = cli(fixture.state, ["read-artifact", "--task-id", "task-cli", "--artifact", "receipt"]);
    assert.equal(receipt.data.status, "completed");
    const diff = cli(fixture.state, ["read-artifact", "--task-id", "task-cli", "--artifact", "diff"]);
    assert.deepEqual(diff.data.unexpected_modified_paths, []);
    const commands = cli(fixture.state, ["read-artifact", "--task-id", "task-cli", "--artifact", "commands"]);
    assert.ok(commands.entries.some(entry => entry.kind === "codex_exec"));
    const status = cli(fixture.state, ["status"]);
    assert.equal(status.tasks.find(task => task.task_id === "task-cli").status, "completed");

    const rejectedPlanPath = path.join(fixture.root, "rejected-contract.json");
    fs.writeFileSync(rejectedPlanPath, `${JSON.stringify(contractFor(snapshot, "task-rejected", fixture.repository), null, 2)}\n`);
    assert.equal(cli(fixture.state, ["import-plan", "--file", rejectedPlanPath]).status, "imported");
    const rejected = cli(fixture.state, ["reject", "--task-id", "task-rejected", "--reason", "operator hold"]);
    assert.equal(rejected.status, "rejected");
  } finally {
    cleanup(fixture, worktree);
  }
});

test("stale snapshot is rejected and execute writes a blocked receipt without creating a worktree", async () => {
  const fixture = makeFixture();
  try {
    const snapshotResult = await createSnapshot({ root: fixture.repository, state: fixture.state });
    const snapshot = { ...snapshotResult };
    delete snapshot.path;
    const planPath = path.join(fixture.root, "stale-contract.json");
    fs.writeFileSync(planPath, `${JSON.stringify(contractFor(snapshot, "task-stale", fixture.repository), null, 2)}\n`);
    await importPlan({ file: planPath, state: fixture.state });
    await approvePlan({ taskId: "task-stale", state: fixture.state, yes: true });
    fs.appendFileSync(path.join(fixture.repository, "README.md"), "changed after snapshot\n");

    const validation = await validatePlan({ taskId: "task-stale", state: fixture.state });
    assert.equal(validation.status, "HOLD");
    assert.match(validation.reason, /dirty|tree_hash|状态哈希/);
    const receipt = await executePlan({ taskId: "task-stale", state: fixture.state, yes: true, codexBin: "/definitely/missing/codex" });
    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.worktree.created, false);
    assert.equal(fs.existsSync(receipt.worktree.path || ""), false);
    assert.ok(fs.existsSync(path.join(fixture.state, "tasks", "task-stale", "EXECUTION_RECEIPT.json")));
    assert.ok(fs.existsSync(path.join(fixture.state, "tasks", "task-stale", "commands.jsonl")));
    assert.ok(fs.existsSync(path.join(fixture.state, "tasks", "task-stale", "test_results.json")));
    assert.ok(fs.existsSync(path.join(fixture.state, "tasks", "task-stale", "diff_manifest.json")));
    assert.equal(handoffStatus({ state: fixture.state }).tasks[0].status, "blocked");
    assert.equal(readHandoffArtifact({ state: fixture.state, taskId: "task-stale", artifact: "receipt" }).data.status, "blocked");
  } finally {
    cleanup(fixture);
  }
});
