#!/usr/bin/env node
import { approvePlan, createSnapshot, executePlan, handoffStatus, importPlan, readHandoffArtifact, readTaskSchema, rejectPlan, stateRoot, validatePlan } from "./handoff-core.mjs";

function parseArgs(argv) {
  const action = argv.shift();
  const options = {};
  while (argv.length > 0) {
    const item = argv.shift();
    if (item === "--yes" || item === "--run-validation") options[item.slice(2).replaceAll("-", "_")] = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replaceAll("-", "_");
      const value = argv.shift();
      if (!value || value.startsWith("--")) throw new Error(`${item} 缺少值`);
      options[key] = value;
    } else throw new Error(`未知参数: ${item}`);
  }
  return { action, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`缺少 --${name.replaceAll("_", "-")}`);
  return options[name];
}

async function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  const state = stateRoot(options.state_root);
  let result;
  if (action === "snapshot") result = await createSnapshot({ root: required(options, "root"), state });
  else if (action === "import-plan") result = await importPlan({ file: required(options, "file"), state });
  else if (action === "validate") result = await validatePlan({ taskId: required(options, "task_id"), state });
  else if (action === "approve") result = await approvePlan({ taskId: required(options, "task_id"), state, yes: options.yes === true });
  else if (action === "execute") result = await executePlan({ taskId: required(options, "task_id"), state, yes: options.yes === true, runValidation: options.run_validation === true, codexBin: options.codex_bin, model: options.model });
  else if (action === "reject") result = await rejectPlan({ taskId: required(options, "task_id"), state, reason: options.reason || "rejected_by_local_operator" });
  else if (action === "status") result = handoffStatus({ state });
  else if (action === "read-artifact") result = readHandoffArtifact({ state, taskId: required(options, "task_id"), artifact: options.artifact || "receipt" });
  else if (action === "schema") result = readTaskSchema(options.name || "TASK_CONTRACT.schema.json");
  else throw new Error("用法: snapshot | import-plan | validate | approve | execute | reject | status | read-artifact | schema");
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
