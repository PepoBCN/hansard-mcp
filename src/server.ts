import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { tools } from './tools/index.js';
import { prompts, type PromptArgs } from './prompts/index.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { newRequestId } from './core/requestId.js';
import { logger } from './core/logger.js';
import { EngineError } from './core/errors.js';
import { counter, observe } from './core/metrics.js';

const INSTRUCTIONS = `UK Parliament data through intent-led tools.

READING RESULTS — this matters more than anything else here.
Every tool returns { data, sources, meta }. \`meta.sources_status\` reports each
upstream separately. An empty section is evidence that Parliament did nothing
ONLY when that source's status is "ok". Any other status (timeout,
upstream_error, circuit_open, unavailable) means the data is UNKNOWN: say it
could not be retrieved. Never turn a failed lookup into a claim that Parliament
has taken no action — that is a false statement about the public record.

\`meta.partial\` is true when any source degraded, and \`meta.warnings\` names them.
\`meta.request_id\` identifies the call in the server's logs; quote it when
reporting a problem.

CITATIONS — every response carries a \`sources\` array of official URLs. Cite them
inline for any factual claim. Do not fabricate URLs.

Data is provided under the Open Parliament Licence v3.0. When surfacing this
output to end users, attribute as: "Contains Parliamentary information licensed
under the Open Parliament Licence v3.0."`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: (tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape,
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        const requestId = newRequestId();
        const started = Date.now();
        try {
          const parsed = tool.inputSchema.parse(args);
          const result = await tool.handler(parsed, { requestId });
          observe('tool_duration_ms', Date.now() - started, { tool: tool.name, outcome: 'ok' });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          observe('tool_duration_ms', Date.now() - started, { tool: tool.name, outcome: 'error' });
          counter('tool_errors_total', { tool: tool.name });
          return { content: [{ type: 'text' as const, text: errorText(error, requestId) }], isError: true };
        }
      },
    );
  }

  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.argsSchema },
      // MCP prompt arguments are strings by spec; the SDK widens them to unknown.
      (args: unknown) => ({
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: prompt.render(args as PromptArgs) },
          },
        ],
      }),
    );
  }

  return server;
}

/**
 * Errors carry the server-side request_id and a concrete remedy. The failure
 * that motivated this rebuild surfaced as an opaque string with an id the server
 * had never issued; nothing here may be that unhelpful again.
 *
 * Boundary note: the SDK validates arguments against the registered schema
 * before this handler runs, so a schema violation returns its own -32602 naming
 * the offending field. That is deliberate — the advertised schema is the model's
 * documentation and must stay strict — and it is safe, because a schema error is
 * fully reproducible from the arguments alone. Only failures that need server
 * context to diagnose reach the formatter below, and those all carry a
 * request_id. Where leniency is genuinely correct (numeric strings,
 * out-of-range lookbacks) the schemas coerce and clamp rather than reject, so
 * ordinary model behaviour never reaches validation at all.
 */
function errorText(error: unknown, requestId: string): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    return JSON.stringify({
      error: { code: 'BAD_INPUT', message: `Invalid arguments: ${issues}`, remedy: 'Correct the arguments and retry.', request_id: requestId },
    });
  }
  if (error instanceof EngineError) {
    logger.warn({ request_id: requestId, code: error.code, err: error.message }, 'tool error');
    return JSON.stringify({
      error: { code: error.code, message: error.message, remedy: error.remedy, source: error.source, request_id: requestId },
    });
  }
  logger.error({ request_id: requestId, err: error instanceof Error ? error.message : String(error) }, 'unhandled tool error');
  return JSON.stringify({
    error: {
      code: 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      remedy: 'Report this request_id; the server log carries the full trace.',
      request_id: requestId,
    },
  });
}
