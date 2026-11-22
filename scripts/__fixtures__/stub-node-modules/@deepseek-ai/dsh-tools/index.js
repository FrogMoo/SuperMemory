/**
 * smoke-only stub of @deepseek-ai/dsh-tools.
 *
 * defineTool is intentionally the identity function: the smoke only needs the
 * definition object handed to ctx.tools.register so it can assert on the
 * registration options (the { when } workspace-visibility gate). Tool semantics
 * are covered by capabilityToolDef / runCapability unit cases, not here.
 */
export function defineTool(definition) {
  return definition
}

export default { defineTool }
