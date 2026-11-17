// Standalone reproduction: build each tool definition with the HOST's
// defineTool and validate the output schema exactly like ctx.tools.register
// does (assertSupportedJsonSchema), to surface which definition is invalid.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const anchor = 'D:\\01 - software\\DSH Desktop\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'
const req = createRequire(anchor)
const toolsUrl = pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href
const tools = await import(toolsUrl)
console.log('defineTool:', typeof tools.defineTool, '| assertSupportedJsonSchema:', typeof tools.assertSupportedJsonSchema)

const cases = {
  memory_remember: () => tools.defineTool({
    name: 'memory_remember',
    description: 'x',
    parameters: {
      text: { type: 'string', required: true, description: 't' },
      key: { type: 'string', description: 'k' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['stored', 'updated', 'conflict', 'duplicate'], required: true },
          memoryId: { type: 'string' },
          message: { type: 'string', required: true },
          conflict: {
            type: 'object',
            properties: {
              memoryId: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: '' }],
    },
    execute: async () => ({}),
  }),
  memory_topicsets: () => tools.defineTool({
    name: 'memory_topicsets',
    description: 'x',
    parameters: { topicSetId: { type: 'string', description: 'id' } },
    output: {
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                branches: { type: 'integer', required: true },
                model: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          total: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: '' }],
    },
    execute: async () => ({}),
  }),
  memory_dispatch: () => tools.defineTool({
    name: 'memory_dispatch',
    description: 'x',
    parameters: {
      task: { type: 'string', required: true, description: 't' },
      topicSetId: { type: 'string', description: 'id' },
      mode: { type: 'string', enum: ['auto', 'continue', 'fork', 'new'], description: 'm' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['dispatched', 'error'], required: true },
          dispatchId: { type: 'string' },
          branchSessionId: { type: 'string' },
          topicSetId: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: '' }],
    },
    execute: async () => ({}),
  }),
  memory_set_model: () => tools.defineTool({
    name: 'memory_set_model',
    description: 'x',
    parameters: {
      topicSetId: { type: 'string', description: 'id' },
      branchSessionId: { type: 'string', description: 'id' },
      provider: { type: 'string', description: 'p' },
      model: { type: 'string', description: 'm' },
      reasoningEffort: { type: 'string', description: 'e' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['applied', 'catalog', 'error'], required: true },
          applied: { type: 'string' },
          live: { type: 'boolean' },
          catalog: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string', required: true },
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: '' }],
    },
    execute: async () => ({}),
  }),
}

for (const [name, build] of Object.entries(cases)) {
  try {
    const definition = build()
    tools.assertSupportedJsonSchema(definition.output.schema)
    console.log(`OK   ${name}`)
  } catch (error) {
    console.log(`FAIL ${name} :: ${String(error?.message ?? error).slice(0, 300)}`)
  }
}
