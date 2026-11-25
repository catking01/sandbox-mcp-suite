export const READ_TOOL_NAMES = Object.freeze([
  "project.list_projects",
  "project.get_project_summary",
  "project.get_project_progress",
  "project.list_tree",
  "project.read_text_file",
  "project.search_text",
  "project.get_manifest",
  "project.get_git_status",
  "project.get_git_diff",
  "project.get_recent_artifacts",
  "project.read_file_base64",
  "project.list_archive_entries",
  "project.read_archive_text_file",
  "project.read_archive_file_base64",
  "handoff.get_status",
  "handoff.read_contract",
  "handoff.read_receipt",
  "handoff.read_artifact_manifest",
  "handoff.read_schema"
]);

export const TOOL_CATALOG = Object.freeze([
  { name: "project.list_projects", group: "read", label: "项目列表", description: "查看已开放的项目目录。" },
  { name: "project.get_project_summary", group: "read", label: "项目摘要", description: "读取项目模式、策略和 Git 摘要。" },
  { name: "project.get_project_progress", group: "read", label: "项目进度", description: "读取配置的当前状态和工作契约文档。" },
  { name: "project.list_tree", group: "read", label: "目录树", description: "列出 allowlist 范围内的文件。" },
  { name: "project.read_text_file", group: "read", label: "读取文本", description: "读取 allowlist 范围内的 UTF-8 文本文件。" },
  { name: "project.search_text", group: "read", label: "搜索文本", description: "在允许读取的文本文件中搜索字面量。" },
  { name: "project.get_manifest", group: "read", label: "文件清单", description: "读取允许文件的大小和 SHA-256。" },
  { name: "project.get_git_status", group: "read", label: "Git 状态", description: "读取项目的只读 Git 状态。" },
  { name: "project.get_git_diff", group: "read", label: "Git Diff", description: "读取项目当前差异摘要和文件名。" },
  { name: "project.get_recent_artifacts", group: "read", label: "最近 Artifacts", description: "列出项目中最近的 artifacts。" },
  { name: "project.read_file_base64", group: "read", label: "读取二进制", description: "在大小限制内读取文件的 Base64。" },
  { name: "project.list_archive_entries", group: "read", label: "压缩包目录", description: "列出允许压缩包中的可见条目。" },
  { name: "project.read_archive_text_file", group: "read", label: "读取压缩包文本", description: "读取压缩包中的可见文本条目。" },
  { name: "project.read_archive_file_base64", group: "read", label: "读取压缩包二进制", description: "读取压缩包文件的 Base64。" },
  { name: "handoff.get_status", group: "read", label: "Handoff 状态", description: "只读查看本地任务、快照和执行状态。" },
  { name: "handoff.read_contract", group: "read", label: "任务契约", description: "只读查看已导入的 TASK_CONTRACT。" },
  { name: "handoff.read_receipt", group: "read", label: "执行收据", description: "只读查看执行状态和边界声明。" },
  { name: "handoff.read_artifact_manifest", group: "read", label: "执行 artifacts", description: "只读查看命令日志、测试结果和 diff manifest。" },
  { name: "handoff.read_schema", group: "read", label: "Handoff schema", description: "只读查看任务契约或执行收据 schema。" },
]);

export const ALL_TOOL_NAMES = Object.freeze(TOOL_CATALOG.map((tool) => tool.name));
const READ_TOOL_SET = new Set(READ_TOOL_NAMES);

export function defaultPermissionsConfig() {
  return {
    schema_version: "sandbox_mcp_permissions.v1",
    profiles: {
      readonly: {
        tools: Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.name, tool.group === "read"]))
      }
    }
  };
}

export function validatePermissionsConfig(config) {
  if (config?.schema_version !== "sandbox_mcp_permissions.v1" || !config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
    throw new Error("MCP 权限配置结构无效");
  }
  const readonly = config.profiles.readonly;
  if (!readonly || typeof readonly !== "object" || Array.isArray(readonly) || !readonly.tools || typeof readonly.tools !== "object" || Array.isArray(readonly.tools)) {
    throw new Error("MCP 只读权限配置无效");
  }
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || !profile.tools || typeof profile.tools !== "object" || Array.isArray(profile.tools)) {
      throw new Error(`MCP 权限 profile 无效: ${profileName}`);
    }
    for (const [toolName, enabled] of Object.entries(profile.tools)) {
      if (!ALL_TOOL_NAMES.includes(toolName)) throw new Error(`未知 MCP 工具权限: ${toolName}`);
      if (typeof enabled !== "boolean") throw new Error(`MCP 工具权限必须是布尔值: ${toolName}`);
    }
  }
  return config;
}

export function toolInfo(toolName) {
  return TOOL_CATALOG.find((tool) => tool.name === toolName) ?? null;
}

export function isToolConfiguredEnabled(config, profileName, toolName) {
  const info = toolInfo(toolName);
  if (!info) return false;
  const configured = config?.profiles?.[profileName]?.tools?.[toolName];
  return typeof configured === "boolean" ? configured : info.group === "read";
}

export function isToolEffectiveEnabled(config, profileName, toolName) {
  const info = toolInfo(toolName);
  if (!info || !isToolConfiguredEnabled(config, profileName, toolName)) return false;
  return READ_TOOL_SET.has(toolName);
}

export function effectiveToolNames(config, profileName, options = {}) {
  return ALL_TOOL_NAMES.filter((toolName) => isToolEffectiveEnabled(config, profileName, toolName, options));
}

export function permissionSnapshot(config, profileName = "readonly", options = {}) {
  const tools = TOOL_CATALOG.map((tool) => ({
    ...tool,
    configured: isToolConfiguredEnabled(config, profileName, tool.name),
    effective: isToolEffectiveEnabled(config, profileName, tool.name),
    locked: false,
    locked_reason: null
  }));
  return {
    profile: profileName,
    configured_count: tools.filter((tool) => tool.configured).length,
    effective_count: tools.filter((tool) => tool.effective).length,
    tools
  };
}

export function isReadTool(toolName) {
  return READ_TOOL_SET.has(toolName);
}
