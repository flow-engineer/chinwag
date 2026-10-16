// Nudges and people's time zones over HTTP: handlers the owner mounts in their own server, so a
// backend that is a separate service can reach the agent without routes of its own. Behind one
// bearer token each.
//
// nudgeHandler:
//   POST {base}        { to: { channel, address }, text | prompt | template, at?, idempotency_key? }
//                      → 202 { id, status, reason? } as soon as it is recorded, before any send or turn
//   GET  {base}/:id    → 200 { id, status, reason? }, its state now; 404 for an id the agent never recorded
//
// peopleHandler: a person's time zone and quiet hours as the business knows them, and their contact
// record (see its doc comment below).
//
// The token lock (a token of at least 32 characters, compared in constant time, wrong tries limited
// per address) is shared with the deployed playground.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Agent, NudgeInput, NudgeState } from "./agent.ts";
import { declaredTemplate, fillTemplate } from "./channels.ts";

/** Wrong tokens one address may try in a window before it is refused for the rest of it. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_BODY = 16_384;

/** Throws unless the token is a string of at least 32 characters; `what` names who needs it. */
export function requireToken(token: unknown, what: string): asserts token is string {
  if (typeof token !== "string" || token.length < 32) throw new Error(`${what} needs a token of at least 32 characters`);
}

/** Whether two secrets are the same, in constant time whatever their lengths. */
export function sameSecret(given: string, wanted: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(given), hash(wanted));
}

/** Wrong tokens per address: past MAX_FAILURES in a window, the address is refused until it ends. */
export function wrongTries() {
  const failures = new Map<string, { count: number; until: number }>();
  return {
    blocked(ip: string): boolean {
      const failed = failures.get(ip);
      if (failed && failed.until <= Date.now()) failures.delete(ip);
      return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES;
    },
    failed(ip: string): void {
      const now = Date.now();
      for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
      const entry = failures.get(ip) ?? { count: 0, until: now + FAILURE_WINDOW_MS };
      entry.count++;
      failures.set(ip, entry);
    },
  };
}

export interface NudgeHandlerOptions {
  /** At least 32 characters, from a secret; callers send it as `Authorization: Bearer <token>`. */
  token: string;
  /** The path it answers under. Default "/nudges". */
  base?: string;
}

const Header = z.union([
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.enum(["image", "video", "document"]), url: z.string().optional(), fileId: z.string().optional() }).strict(),
]);
const Template = z
  .object({
    name: z.string().min(1),
    language: z.string().optional(),
    header: Header.optional(),
    body: z.array(z.string()).optional(),
    buttons: z.array(z.object({ index: z.number().int().nonnegative(), value: z.string() }).strict()).optional(),
    variables: z.record(z.string(), z.string()).optional(),
  })
  .strict();
const Body = z
  .object({
    to: z.object({ channel: z.string().min(1), address: z.string().min(1) }).strict(),
    text: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    template: Template.optional(),
    /** Milliseconds since the epoch, as `agent.nudge()` takes it. */
    at: z.number().int().nonnegative().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
    /** Wait for the end of their quiet hours (default true). */
    respect_quiet_hours: z.boolean().optional(),
    /** Held for quiet hours past this (ms since the epoch), it is dropped as expired. */
    expires_at: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((b) => [b.text, b.prompt, b.template].filter((v) => v !== undefined).length === 1, { message: "give exactly one of text, prompt or template" })
  .refine((b) => !(b.template && b.at !== undefined), { message: "a template nudge cannot be scheduled yet: leave out at" });

/** What the handler needs from an agent; Chinwag's Agent is one. */
export type NudgeAgent = Pick<Agent, "recordNudge" | "nudgeState" | "channels" | "templates">;

/**
 * Nudges over HTTP, as a request handler for your own server: hand it the requests under `base`.
 * Requests outside `base` get 404 without a token check. A nudge refused or dropped as it is
 * recorded (unknown_person, outside_window, a STOP) is still a 202: that is the nudge's state, not
 * an HTTP error.
 */
export function nudgeHandler(agent: NudgeAgent, options: NudgeHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  requireToken(options?.token, "chinwag nudges");
  const token = options.token;
  const base = withoutTrailingSlashes(options.base ?? "/nudges");
  const tries = wrongTries();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const id = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
    if (path !== base && (id === null || !id || id.includes("/"))) return json(res, 404, { error: "not found" });

    const ip = req.socket.remoteAddress ?? "unknown";
    if (!authorized(req, res, ip, token, tries)) return;

    if (id !== null) {
      if (req.method !== "GET") return json(res, 404, { error: "not found" });
      let asked: string;
      try {
        asked = decodeURIComponent(id);
      } catch {
        return json(res, 404, { error: "no nudge with this id" });
      }
      const state = await agent.nudgeState(asked);
      return state ? json(res, 200, state) : json(res, 404, { error: "no nudge with this id" });
    }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });

    const raw = await readBody(req);
    if (raw === undefined) return json(res, 400, { error: `the body must be JSON of at most ${MAX_BODY} bytes` });
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") });
    const body = parsed.data;
    const channels = agent.channels().map((c) => c.name);
    if (!channels.includes(body.to.channel)) return json(res, 400, { error: `to.channel must be one of the agent's channels: ${channels.join(", ") || "it has none"}` });
    if (body.template) {
      // A declared template sent with values that don't fit it is a bad request, not a failed nudge.
      const declared = declaredTemplate(agent.templates(), body.template);
      try {
        if (declared) fillTemplate(declared, body.template);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const { idempotency_key, respect_quiet_hours, expires_at, ...rest } = body;
    const input: NudgeInput = {
      ...rest,
      ...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
      ...(respect_quiet_hours !== undefined ? { respectQuietHours: respect_quiet_hours } : {}),
      ...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
    };
    const state: NudgeState = await agent.recordNudge(input);
    const kind = body.text !== undefined ? "text" : body.prompt !== undefined ? "prompt" : "template";
    console.info(JSON.stringify({ chinwag: "nudge", id: state.id, status: state.status, ...(state.reason ? { reason: state.reason } : {}), channel: body.to.channel, kind, at: new Date().toISOString(), ip }));
    return json(res, 202, state);
  }

  return (req, res) =>
    handle(req, res).catch((error) => {
      console.warn("chinwag nudges:", error);
      if (!res.headersSent) json(res, 500, { error: "the nudge could not be recorded" });
    });
}

/** Checks the bearer token, answering 401 or 429 itself when it fails. */
function authorized(req: IncomingMessage, res: ServerResponse, ip: string, token: string, tries: ReturnType<typeof wrongTries>): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  let refusal: [number, string] | null = null;
  if (bearer === undefined) refusal = [401, "send Authorization: Bearer <token>"];
  else if (tries.blocked(ip)) refusal = [429, "too many wrong tokens from this address; try again later"];
  else if (!sameSecret(bearer, token)) {
    tries.failed(ip);
    refusal = [401, "wrong token"];
  }
  if (refusal) json(res, refusal[0], { error: refusal[1] });
  return refusal === null;
}

export interface PeopleHandlerOptions {
  /** At least 32 characters, from a secret; callers send it as `Authorization: Bearer <token>`. */
  token: string;
  /** The path it answers under. Default "/people". */
  base?: string;
}

const To = z.object({ channel: z.string().min(1), address: z.string().min(1) }).strict();
const TimeZoneBody = z.object({ to: To, time_zone: z.string().min(1) }).strict();
const Hours = z.object({ from: z.string(), to: z.string() }).strict();
const QuietHoursBody = z.object({ to: To, quiet_hours: z.union([Hours, z.literal("off"), z.null()]) }).strict();

/**
 * What a business knows about people, over HTTP: their time zone and quiet hours, and their whole
 * contact record (what they and the business set). Requests outside `base` get 404 without a token check.
 *
 *   PUT {base}/time-zone    { to, time_zone }                       → 200 { status: "set" }
 *   PUT {base}/quiet-hours  { to, quiet_hours: { from, to } | "off" | null }  (null: the agent's)
 *   GET {base}/contact?channel=&address=                            → 200 the contact record
 *
 * Someone who never wrote is 404 `{ status: "refused", reason: "unknown_person" }`.
 */
export function peopleHandler(agent: Pick<Agent, "setTimeZone" | "setQuietHours" | "contact" | "channels">, options: PeopleHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  requireToken(options?.token, "chinwag people");
  const token = options.token;
  const base = withoutTrailingSlashes(options.base ?? "/people");
  const tries = wrongTries();
  const routes = new Set(["time-zone", "quiet-hours", "contact"]);
  const unknown = { status: "refused", reason: "unknown_person" };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : "";
    if (!routes.has(route)) return json(res, 404, { error: "not found" });
    const ip = req.socket.remoteAddress ?? "unknown";
    if (!authorized(req, res, ip, token, tries)) return;
    const channels = agent.channels().map((c) => c.name);
    const badChannel = (channel: string) => (channels.includes(channel) ? null : `to.channel must be one of the agent's channels: ${channels.join(", ") || "it has none"}`);

    if (route === "contact") {
      if (req.method !== "GET") return json(res, 404, { error: "not found" });
      const to = { channel: url.searchParams.get("channel") ?? "", address: url.searchParams.get("address") ?? "" };
      if (!to.channel || !to.address) return json(res, 400, { error: "give channel and address as query parameters" });
      const problem = badChannel(to.channel);
      if (problem) return json(res, 400, { error: problem });
      const contact = await agent.contact(to);
      return contact ? json(res, 200, contact) : json(res, 404, unknown);
    }
    if (req.method !== "PUT") return json(res, 404, { error: "not found" });
    const raw = await readBody(req);
    if (raw === undefined) return json(res, 400, { error: `the body must be JSON of at most ${MAX_BODY} bytes` });
    const parsed = (route === "time-zone" ? TimeZoneBody : QuietHoursBody).safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") });
    const body = parsed.data as { to: { channel: string; address: string }; time_zone?: string; quiet_hours?: { from: string; to: string } | "off" | null };
    const problem = badChannel(body.to.channel);
    if (problem) return json(res, 400, { error: problem });
    let result;
    try {
      result = route === "time-zone" ? await agent.setTimeZone({ to: body.to, timeZone: body.time_zone! }) : await agent.setQuietHours({ to: body.to, quietHours: body.quiet_hours ?? null });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message.replace(/^chinwag: /, "") : String(error) });
    }
    return json(res, result.status === "set" ? 200 : 404, result);
  }

  return (req, res) =>
    handle(req, res).catch((error) => {
      console.warn("chinwag people:", error);
      if (!res.headersSent) json(res, 500, { error: "that could not be done" });
    });
}

/** A path with its trailing slashes taken off, in one pass (no regular expression to backtrack). */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** The parsed JSON body, or undefined when it is too large or not JSON. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
}
