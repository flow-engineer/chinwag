// Builds Pip. The playground (main.ts) and the tests build it the same way; tests pass their own
// model, events and (simulated) tools.

import { fileURLToPath } from "node:url";
import { createAgent, customUI, openAICompatible, sms, whatsapp, type AgentOptions, type EventSink, type Model, type Tool } from "../../../src/index.ts";
import { tools as cafeTools } from "./tools.ts";

export interface BuildOptions {
  model?: Model;
  events?: EventSink[];
  tools?: Tool[];
  /** Where Pip runs, for a host with no file system (Cloudflare): its files as text, its database, no schedule timer. */
  host?: Pick<AgentOptions, "files" | "database" | "scheduleCheckMs">;
}

export const tools = cafeTools;

// The café's numbers and web chat are not connected yet, so every provider refuses to send. Test
// people write from the playground, and replies to them go back there, never through these.
const notConnected = async () => {
  throw new Error("not connected yet: only test people in the playground reach Pip for now");
};
const provider = { sendMessage: notConnected, react: notConnected, typing: notConnected, markRead: notConnected, status: notConnected };

export function buildAgent(options: BuildOptions = {}) {
  return createAgent({
    ...(options.host ?? { dir: fileURLToPath(new URL("../agent", import.meta.url)) }),
    model: options.model ?? openAICompatible({ model: process.env.CAFE_MODEL }),
    tools: options.tools ?? cafeTools,
    context: () => `Now: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} (New York)`,
    events: options.events ?? [],
    channels: [whatsapp(provider), sms(provider), customUI("web", provider)],
    testPeople: [
      { name: "Maria", phone: "+15555550101" },
      { name: "Sam", phone: "+15555550102" },
      { name: "Priya", phone: "+15555550103" },
    ],
    timeZone: "America/New_York",
  });
}
