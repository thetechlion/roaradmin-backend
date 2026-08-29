/**
 * GameLink Durable Object
 *
 * One instance per live Roblox server (keyed by jobId). The Roblox module
 * opens a long-poll / periodic check-in HTTP request against its instance;
 * the dashboard/Discord bot POST commands to the same instance, which
 * hands them back on the game's next check-in with near-zero latency
 * instead of waiting on a fixed polling interval.
 */
export class GameLink implements DurableObject {
  state: DurableObjectState;
  pending: unknown[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      const command = await request.json();
      this.pending.push(command);
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    }

    if (request.method === "GET" && url.pathname.endsWith("/poll")) {
      const commands = this.pending;
      this.pending = [];
      return new Response(JSON.stringify({ commands }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not_found", { status: 404 });
  }
}
