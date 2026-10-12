import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { config, SERVER_NAME, SERVER_VERSION, BUILD_SHA } from './config.js';
import { logger } from './core/logger.js';
import { renderPrometheus } from './core/metrics.js';
import { newRequestId } from './core/requestId.js';

/**
 * Stateless Streamable HTTP.
 *
 * The deployment this replaces wrapped a stdio server in supergateway with
 * --stateful, which added a dependency, forced every client to hold a session
 * that expired after 30 minutes, and rejected a bare POST. Stateless means any
 * process can serve any request and a restart drops nothing.
 */
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: SERVER_NAME, version: SERVER_VERSION, sha: BUILD_SHA });
});

app.get('/readyz', (_req, res) => {
  // Shallow by design: liveness must never depend on Parliament being up.
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.get('/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4').send(renderPrometheus());
});

app.post('/mcp', async (req, res) => {
  const requestId = newRequestId();
  const started = Date.now();
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    logger.info({ request_id: requestId, ms: Date.now() - started }, 'mcp request');
  } catch (error) {
    logger.error(
      { request_id: requestId, err: error instanceof Error ? error.message : String(error) },
      'mcp transport error',
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error', data: { request_id: requestId } },
        id: null,
      });
    }
  }
});

// GET and DELETE on /mcp are session operations; a stateless server has none.
const noSession = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
    id: null,
  });
};
app.get('/mcp', noSession);
app.delete('/mcp', noSession);

const server = app.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, version: SERVER_VERSION, sha: BUILD_SHA },
    'parliament-mcp-engine listening',
  );
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
