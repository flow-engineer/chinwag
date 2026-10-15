// An in-process tunnel between the test client and a local cloud. No Docker. A seeded pick can
// answer 503 with the Google frontend's HTML page, reset the connection, cut a stream mid-frame,
// or wait a moment. A test can choose the fault for each call instead of the seed.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Fault = "ok" | "html503" | "reset" | "delay" | "cut";

function mix(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Seeded. Posts meet a 503, a reset and a delay. A stream meets a mid-frame cut. */
export function rollFault(seed: number, index: number, kind: "post" | "stream"): Fault {
  const roll = mix((seed + 1) * 1000 + index);
  if (kind === "stream") return roll < 0.25 ? "cut" : "ok";
  if (roll < 0.2) return "html503";
  if (roll < 0.4) return "reset";
  if (roll < 0.6) return "delay";
  return "ok";
}

const HTML = "<html><title>503 Server Error</title><h1>Error: Server Error</h1>Service error -27.</html>";

export async function startFaultProxy(upstream: string, options: {
  seed: number;
  fault?: (info: { kind: "post" | "stream"; path: string; index: number }) => Fault;
}): Promise<{ url: string; posts: Array<{ path: string; body: string }>; close: () => void }> {
  const target = new URL(upstream);
  let index = 0;
  const posts: Array<{ path: string; body: string }> = [];
  const decide = options.fault ?? ((info: { kind: "post" | "stream"; path: string; index: number }) => rollFault(options.seed, info.index, info.kind));
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const kind = path.endsWith("/stream") ? "stream" as const : "post" as const;
    const fault = decide({ kind, path, index: index++ });
    if (fault === "html503") {
      req.resume();
      res.writeHead(503, { "content-type": "text/html" }).end(HTML);
      return;
    }
    if (fault === "reset") {
      req.resume();
      res.destroy();
      return;
    }
    const go = () => forward(target, req, res, path, fault === "cut", posts);
    if (fault === "delay") setTimeout(go, 30);
    else go();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

function forward(target: URL, req: IncomingMessage, res: ServerResponse, path: string, cut: boolean, posts: Array<{ path: string; body: string }>): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.method !== "GET" && req.method !== "HEAD") posts.push({ path, body: body.toString("utf8") });
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (up) => {
      if (!cut) {
        res.writeHead(up.statusCode ?? 200, up.headers);
        up.pipe(res);
        return;
      }
      const acc: Buffer[] = [];
      up.on("data", (chunk) => acc.push(chunk));
      up.on("end", () => {
        const bytes = Buffer.concat(acc);
        if (!res.headersSent) res.writeHead(up.statusCode ?? 200, { "content-type": up.headers["content-type"] ?? "text/event-stream" });
        res.write(bytes.subarray(0, Math.min(8, bytes.length)));
        res.destroy();
      });
    });
    upstream.on("error", () => res.destroy());
    upstream.end(body);
  });
}
