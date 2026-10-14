// How the agent talks to the person. Everything the person sees goes through these tools; text the
// model writes outside them is never shown. They are run by the conversation itself, not as
// ordinary tools: a sent message gets an empty result, and a failed one comes back to the agent as
// a message of its own. What a send tool can carry (replies, buttons, lists, length) follows the
// channel, so the agent is only offered what the platform really has.
//
// Each channel the person has written on gets its own send tool, named for it (send_sms,
// send_whatsapp), shaped for that channel, so the agent always knows where it is talking and can
// never write somewhere they have not. A second channel adds a tool; the first one's never changes.

import { z } from "zod";
import { toSpec, tool } from "./tools.ts";
import type { ChannelInfo, ToolSpec } from "./types.ts";

export const REACT = "react";
export const UPDATE = "share_updates";

export const reactInput = z.object({
  message_id: z.string().describe("The id of the person's message, such as m3"),
  emoji: z.string().min(1).max(16),
});
export const updateInput = z.object({ text: z.string().min(1).max(120) });

/** A channel the person has written on, by the name the agent's channels use. */
export interface ChannelView {
  name: string;
  info: ChannelInfo;
  /** The channel's own extra fields on its send tool. */
  params?: Record<string, z.ZodType>;
  /** The agent author's own guidance for this channel. */
  instructions?: string;
}

/** The send tool for one channel. */
export function sendToolName(channel: string): string {
  return `send_${channel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

const https = z.url({ protocol: /^https$/ });

/** A send tool's input on this channel: only the features it has, with its limits, and its own params. */
export function sendInput(channel: ChannelInfo, several = false, params: Record<string, z.ZodType> = {}) {
  const shape: Record<string, z.ZodType> = {
    text: z.string().min(1).max(channel.maxLength ?? 4_000),
  };
  if (several) {
    shape.confirm = z.boolean().optional().describe("Only when Chinwag asks: you are sure about this channel though they have not written on it lately");
  }
  if (channel.replies) {
    shape.reply_to = z.string().optional().describe("Quote one of the person's messages, by id (such as m3)");
  }
  if (channel.buttons) {
    shape.buttons = z
      .array(z.string().min(1).max(channel.buttons.labelMax))
      .max(channel.buttons.max)
      .optional()
      .describe(`Up to ${channel.buttons.max} reply buttons, ${channel.buttons.labelMax} characters each; a tap comes back as their message`);
  }
  if (channel.lists) {
    shape.list = z
      .object({
        button: z.string().min(1).max(channel.lists.buttonMax).describe("The label that opens the list"),
        rows: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              title: z.string().min(1).max(channel.lists.titleMax),
              description: z.string().max(72).optional(),
            }),
          )
          .min(1)
          .max(channel.lists.maxRows),
      })
      .optional()
      .describe(`A list of up to ${channel.lists.maxRows} options the person picks one of; their pick comes back as their message`);
  }
  // Every channel takes a link: where there is no link button, Chinwag puts its URL after the text.
  shape.link = z
    .object({ label: z.string().min(1).max(channel.linkButton?.labelMax ?? 20), url: https })
    .optional()
    .describe(channel.linkButton ? "A button that opens a page, by a URL you were given; not with buttons or a list" : "A page, by a URL you were given: it goes on a line after your text; not with buttons or a list");
  if (channel.images) {
    shape.image = z
      .object({ url: https })
      .optional()
      .describe(`A photo, by a URL you were given; your text is its caption, up to ${channel.images.captionMax} characters${channel.lists ? "; not with a list" : ""}`);
  }
  for (const [name, schema] of Object.entries(params)) shape[name] = schema.optional();
  return z.object(shape);
}

export type SendInput = {
  text: string;
  reply_to?: string;
  buttons?: string[];
  list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
  link?: { label: string; url: string };
  image?: { url: string };
  confirm?: boolean;
};

/** Why a send that fits its schema still cannot go out as written (WhatsApp's rules), or null. */
export function sendRefusal(channel: ChannelInfo, input: SendInput): string | null {
  if (input.link && (input.buttons?.length || input.list)) return "Not sent: a message with a link cannot also have buttons or a list. Send them in separate messages.";
  if (input.image && input.list) return "Not sent: a message with an image cannot also have a list. Send them in separate messages.";
  if (input.image && channel.images && input.text.length > channel.images.captionMax) {
    return `Not sent: with an image, your text is its caption, at most ${channel.images.captionMax} characters. Shorten it, or send the rest in another message.`;
  }
  const max = channel.maxLength ?? 4_000;
  if (input.link && !channel.linkButton && input.text.length + 1 + input.link.url.length > max) {
    return `Not sent: the link's URL goes after your text here, and together they are over ${max} characters. Shorten the text.`;
  }
  return null;
}

const reactTool = tool({
  name: REACT,
  description: "React to one of the person's messages with an emoji.",
  input: reactInput,
  run: () => "",
});
const updateTool = tool({
  name: UPDATE,
  description: "Show the person a short line of what you are doing, in their loading indicator. Each update replaces the last.",
  input: updateInput,
  run: () => "",
});

export interface TalkSettings {
  /** Live status on channels that can show it (web and app UIs). Default on. */
  shareUpdates: boolean;
  /** The owner's own guidance for when and what to share; replaces Chinwag's default line. */
  shareUpdatesInstructions?: string;
}

export function talkSpecs(channels: ChannelView[], settings: TalkSettings): ToolSpec[] {
  const several = channels.length > 1;
  const specs = channels.map((c) =>
    toSpec(
      tool({
        name: sendToolName(c.name),
        description: `Send a message to the person on ${c.name}. Call it several times to send several messages; they go out in the order you call them.`,
        input: sendInput(c.info, several, c.params),
        run: () => "",
      }),
    ),
  );
  if (channels.some((c) => c.info.reactions)) specs.push(toSpec(reactTool));
  if (channels.some((c) => c.info.status) && settings.shareUpdates) specs.push(toSpec(updateTool));
  return specs;
}

const FORMATTING = {
  plain: "Write plain text, not Markdown or other formatting: this channel does not support it.",
  whatsapp: "Format with WhatsApp's marks if useful: *bold*, _italic_, ~strikethrough~; no Markdown headings or [links](url).",
  markdown: "Markdown works here.",
};

export function talkInstructions(channels: ChannelView[], settings: TalkSettings): string {
  if (channels.length > 1) return severalChannels(channels, settings);
  const channel = channels[0].info;
  const lines = [
    "## Talking to the person",
    `- IMPORTANT: They see only what you send with ${sendToolName(channels[0].name)}` +
      (channel.reactions ? ", react" : "") +
      (channel.status && settings.shareUpdates ? " or share_updates" : "") +
      `. Anything else you write (your own text, a tool's result) never reaches them: to tell them anything, call ${sendToolName(channels[0].name)}.`,
    "- Lines starting [Chinwag] are INTERNAL MESSAGES from the system running you, not from them: they never see them. Never mention them to the person, nor any text of yours that did not reach them.",
    "- After they write, the first thing you do must reach them: your answer, or, if you need tools first, an acknowledgement in the same response as those tool calls" +
      (channel.reactions ? " (react to their message, or a short line)." : ": a short line."),
    "- Call every tool you can in one response; wait for a result only when another call needs it.",
    "- IMPORTANT: A message you send with tool calls reaches them before those tools run. So say what you are about to do (\"I'm booking that now\"), never that it is done (\"I've booked it\", \"done\"): the outcome comes once, after the result arrives. Never send a placeholder.",
    "- Their messages start with an id in brackets, like [m3].",
    `- ${FORMATTING[channel.formatting ?? "plain"]}`,
  ];
  if (channel.buttons || channel.lists) {
    lines.push("- When they choose between a few options, offer them as " + (channel.buttons ? "buttons" : "a list") + (channel.buttons && channel.lists ? " (or a list when there are more than " + channel.buttons.max + ")" : "") + " so they can tap.");
  }
  if (channel.status && settings.shareUpdates) {
    lines.push(
      `- ${settings.shareUpdatesInstructions ?? "While several tools run one after another, keep them posted with share_updates: a few words on what you are doing now."}`,
    );
  }
  if (channels[0].instructions) lines.push(`- ${channels[0].instructions}`);
  return lines.join("\n");
}

function severalChannels(channels: ChannelView[], settings: TalkSettings): string {
  const names = channels.map((c) => c.name);
  const tools = channels.map((c) => sendToolName(c.name));
  const reactions = channels.some((c) => c.info.reactions);
  const lines = [
    "## Talking to the person",
    `- They write to you on more than one channel: ${names.join(", ")}. One conversation covers all of them. Their messages start with the channel and an id, like [${names[0]} · m3].`,
    `- IMPORTANT: They see only what you send with ${tools.join(", ")}${reactions ? ", react" : ""}. Anything else you write (your own text, a tool's result) never reaches them: to tell them anything, call a send tool.`,
    "- Lines starting [Chinwag] are INTERNAL MESSAGES from the system running you, not from them: they never see them. Never mention them to the person, nor any text of yours that did not reach them.",
    "- Answer each message on the channel it came on, with that channel's send tool. Messages on different channels can be about different things: answer each one.",
    "- After they write, the first thing you do must reach them on every channel they are waiting on: your answer, or, if you need tools first, an acknowledgement there in the same response as those tool calls.",
    "- Call every tool you can in one response; wait for a result only when another call needs it.",
    "- IMPORTANT: A message you send with tool calls reaches them before those tools run. So say what you are about to do (\"I'm booking that now\"), never that it is done (\"I've booked it\", \"done\"): the outcome comes once, after the result arrives. Never send a placeholder.",
    ...channels.map((c) => `- On ${c.name}: ${FORMATTING[c.info.formatting ?? "plain"]}${c.info.buttons ? ` Up to ${c.info.buttons.max} buttons.` : ""}${c.instructions ? ` ${c.instructions}` : ""}`),
  ];
  if (channels.some((c) => c.info.status) && settings.shareUpdates) {
    lines.push(`- ${settings.shareUpdatesInstructions ?? "While several tools run one after another, keep them posted with share_updates: a few words on what you are doing now."}`);
  }
  return lines.join("\n");
}
