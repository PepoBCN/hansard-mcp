import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behaviour =
  | { kind: 'ok'; body: unknown; delayMs?: number }
  | { kind: 'status'; status: number; delayMs?: number }
  | { kind: 'hang' }
  | { kind: 'malformed' }
  | { kind: 'reset' };

/**
 * A controllable stand-in for a Parliament API. Lets the suite reproduce the
 * exact conditions measured against the real ones: 25s cold starts, 500s, and
 * connections that die mid-flight.
 */
export class MockUpstream {
  private server: http.Server;
  private behaviour: Behaviour = { kind: 'ok', body: {} };
  public requests: string[] = [];
  private open = new Set<import('node:net').Socket>();

  constructor() {
    this.server = http.createServer((req, res) => {
      this.requests.push(req.url ?? '');
      const b = this.behaviour;
      const delay = 'delayMs' in b && b.delayMs ? b.delayMs : 0;

      const respond = () => {
        switch (b.kind) {
          case 'ok':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(b.body));
            break;
          case 'status':
            res.writeHead(b.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `mock ${b.status}` }));
            break;
          case 'malformed':
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"this is not: valid json');
            break;
          case 'reset':
            req.socket.destroy();
            break;
          case 'hang':
            break; // never responds
        }
      };
      if (delay > 0) setTimeout(respond, delay).unref();
      else respond();
    });
    this.server.on('connection', (s) => {
      this.open.add(s);
      s.on('close', () => this.open.delete(s));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  set(behaviour: Behaviour): void {
    this.behaviour = behaviour;
  }

  reset(): void {
    this.requests = [];
    this.behaviour = { kind: 'ok', body: {} };
  }

  async stop(): Promise<void> {
    for (const s of this.open) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
