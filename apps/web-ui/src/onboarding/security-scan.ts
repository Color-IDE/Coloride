/**
 * Static checks on imported configuration. They only flag content for the user to review;
 * nothing imported here is ever executed (`LOT-006`, AGENTS.md rules 1 and 6).
 */

/** Warnings for an MCP server launch command (remote shell pipes, privilege escalation, raw shells). */
export function scanMcpSecurityWarnings(command: string, args: readonly string[]): string[] {
  const warnings: string[] = [];
  const full = `${command} ${args.join(" ")}`.toLowerCase();
  if (
    (full.includes("curl ") || full.includes("wget ")) &&
    (full.includes("| sh") ||
      full.includes("| bash") ||
      full.includes("|sh") ||
      full.includes("|bash"))
  ) {
    warnings.push("CRITICAL: Remote shell pipe execution (`curl/wget | sh`) quarantined.");
  }
  if (full.includes("sudo ") || full.includes("chmod +s")) {
    warnings.push("Privilege escalation command detected (`sudo`). Quarantined.");
  }
  if (/^(sh|bash|\/bin\/sh|\/bin\/bash|powershell|cmd\.exe)\b/.test(full.trim())) {
    warnings.push("Direct shell interpreter requires explicit user scope approval.");
  }
  return warnings;
}

/** Lines of a project convention file (`AGENTS.md`, `.cursorrules`…) that try to weaken the policy. */
export function scanConventionInjectionDirectives(content: string): string[] {
  const flagged: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lower = line.toLowerCase();
    if (
      lower.includes("allow_unsandboxed") ||
      lower.includes("disable_sandbox") ||
      lower.includes("bypass_policy") ||
      lower.includes("override policy") ||
      lower.includes("policy_engine") ||
      lower.includes("auto_approve_all") ||
      (lower.includes("curl ") && lower.includes("| sh")) ||
      lower.includes("sudo ")
    ) {
      flagged.push(`line ${idx + 1}: ${line.trim()}`);
    }
  }
  return flagged;
}
