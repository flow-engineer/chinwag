// Channels: where people reach an agent. Chinwag knows each platform (what WhatsApp can show, its
// limits, its 24-hour window); a provider only says how to send through its own API. A provider
// implements one sendMessage, which gets everything the agent's send tool carries, plus the
// optional actions that are not messages (react, typing, markRead, sendTemplate). A feature the
// provider leaves out, or switches off, is never offered to the agent.
//
//   whatsapp(new MyWhatsApp(keys))                       every WhatsApp feature the provider has
//   whatsapp(new MyWhatsApp(keys), { disable: ["reactions"] })
//   sms(new MySms(keys))
//   customUI("app", new MyApp())                         your own web or mobile UI, with your params

import type { z } from "zod";
import type { ChannelInfo, ListRow, Outbound } from "./types.ts";

export type ChannelKind = "sms" | "whatsapp" | "custom";

/** A channel as the agent uses it. Made by whatsapp(), sms() or customUI(), or written by hand. */
export interface Channel {
  /** The agent's name for it; its send tool is send_<name> when a person uses several. */
  name: string;
  kind: ChannelKind;
  info: ChannelInfo;
  /** Addresses are phone numbers the channel verified, so the same number on two channels is one person. */
  phone?: boolean;
  /** Extra fields of this channel's send tool, passed through to its provider as they are. */
  params?: Record<string, z.ZodType>;
  /** Your own guidance for the agent on this channel, added to its prompt while the person uses it. */
  instructions?: string;
  send(address: string, outbound: Outbound): Promise<void> | void;
}

/** A channel without its send: what the simulators and the test cloud need to play it. */
export interface ChannelSummary {
  name: string;
  kind: ChannelKind;
  info: ChannelInfo;
}

/** One message, as the agent's send tool wrote it. */
export interface Message {
  text: string;
  /** The person's message this one quotes. */
  replyTo?: string;
  buttons?: string[];
  list?: { button: string; rows: ListRow[] };
  /** A button that opens this page. Never with buttons or a list. */
  link?: { label: string; url: string };
  /** A photo, the text its caption. Never with a list. */
  image?: { url: string };
}

export interface Template {
  name: string;
  language?: string;
  variables?: Record<string, string>;
}

export interface WhatsAppProvider {
  sendMessage(to: string, message: Message): Promise<void>;
  /** Which parts of a message this provider can send. Default: all. */
  features?: { buttons?: boolean; lists?: boolean; replies?: boolean; links?: boolean; images?: boolean };
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  sendTemplate?(to: string, template: Template): Promise<void>;
}

export interface SmsProvider {
  sendMessage(to: string, message: { text: string }): Promise<void>;
}

/** Your own UI. `message` carries the text, any buttons, and your params by name. */
export interface CustomUIProvider {
  /** What your UI can show. Default: Markdown, no buttons. */
  info?: Omit<ChannelInfo, "reactions" | "status" | "readReceipts">;
  params?: Record<string, z.ZodType>;
  /** Your own guidance for the agent on this channel, such as how to use your params. */
  instructions?: string;
  sendMessage(to: string, message: Message & Record<string, unknown>): Promise<void>;
  react?(to: string, messageId: string, emoji: string): Promise<void>;
  typing?(to: string, on: boolean): Promise<void>;
  markRead?(to: string, messageIds: string[]): Promise<void>;
  /** A short line of what the agent is doing, in your loading indicator; null clears it. */
  status?(to: string, text: string | null): Promise<void>;
}

/** WhatsApp's own limits, the same for every provider. */
export const WHATSAPP: ChannelInfo = {
  reactions: true,
  status: false,
  formatting: "whatsapp",
  maxLength: 4096,
  replies: true,
  buttons: { max: 3, labelMax: 20 },
  lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
  // An interactive cta_url message: one URL button, its label up to 20 characters.
  linkButton: { labelMax: 20 },
  // An image's caption is at most 1,024 characters (as is an interactive message's body).
  images: { captionMax: 1024 },
  readReceipts: true,
  replyWindowHours: 24,
};

/** SMS: plain text; providers join up to 10 segments into one text (1,530 GSM-7 characters). */
export const SMS: ChannelInfo = { reactions: false, status: false, formatting: "plain", maxLength: 1530 };

export type WhatsAppFeature = "buttons" | "lists" | "links" | "images" | "replies" | "reactions" | "typing" | "readReceipts" | "templates";

export function whatsapp(provider: WhatsAppProvider, options: { name?: string; disable?: WhatsAppFeature[]; instructions?: string } = {}): Channel {
  const off = new Set(options.disable ?? []);
  const has = (feature: WhatsAppFeature, available: boolean) => available && !off.has(feature);
  const f = provider.features ?? {};
  const info: ChannelInfo = {
    ...WHATSAPP,
    reactions: has("reactions", Boolean(provider.react)),
    readReceipts: has("readReceipts", Boolean(provider.markRead)),
    replies: has("replies", f.replies !== false),
    buttons: has("buttons", f.buttons !== false) ? WHATSAPP.buttons : undefined,
    lists: has("lists", f.lists !== false) ? WHATSAPP.lists : undefined,
    linkButton: has("links", f.links !== false) ? WHATSAPP.linkButton : undefined,
    images: has("images", f.images !== false) ? WHATSAPP.images : undefined,
  };
  return {
    name: options.name ?? "whatsapp",
    kind: "whatsapp",
    info,
    instructions: options.instructions,
    phone: true,
    send: (to, outbound) => {
      switch (outbound.type) {
        case "message":
          return provider.sendMessage(to, message(outbound));
        case "reaction":
          return info.reactions ? provider.react?.(to, outbound.messageId, outbound.emoji) : undefined;
        case "typing":
          return has("typing", true) ? provider.typing?.(to, outbound.on) : undefined;
        case "read":
          return info.readReceipts ? provider.markRead?.(to, outbound.messageIds) : undefined;
        case "template":
          if (!provider.sendTemplate || off.has("templates")) throw new Error("this WhatsApp provider sends no templates");
          return provider.sendTemplate(to, { name: outbound.name, language: outbound.language, variables: outbound.variables });
        case "status":
          return;
      }
    },
  };
}

export function sms(provider: SmsProvider, options: { name?: string; instructions?: string } = {}): Channel {
  return {
    name: options.name ?? "sms",
    kind: "sms",
    info: SMS,
    instructions: options.instructions,
    phone: true,
    send: (to, outbound) => {
      if (outbound.type === "message") return provider.sendMessage(to, { text: outbound.text });
      if (outbound.type === "template") throw new Error("SMS has no templates");
      // Reactions, typing, read receipts and status do not exist on SMS.
    },
  };
}

export function customUI(name: string, provider: CustomUIProvider): Channel {
  const info: ChannelInfo = {
    formatting: "markdown",
    ...provider.info,
    reactions: Boolean(provider.react),
    status: Boolean(provider.status),
    readReceipts: Boolean(provider.markRead),
  };
  return {
    name,
    kind: "custom",
    info,
    params: provider.params,
    instructions: provider.instructions,
    send: (to, outbound) => {
      switch (outbound.type) {
        case "message":
          return provider.sendMessage(to, { ...message(outbound), ...outbound.fields });
        case "reaction":
          return provider.react?.(to, outbound.messageId, outbound.emoji);
        case "typing":
          return provider.typing?.(to, outbound.on);
        case "read":
          return provider.markRead?.(to, outbound.messageIds);
        case "status":
          return provider.status?.(to, outbound.text);
        case "template":
          throw new Error(`${name} has no templates`);
      }
    },
  };
}

function message(outbound: Extract<Outbound, { type: "message" }>): Message {
  return {
    text: outbound.text,
    ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
    ...(outbound.buttons ? { buttons: outbound.buttons } : {}),
    ...(outbound.list ? { list: outbound.list } : {}),
    ...(outbound.link ? { link: outbound.link } : {}),
    ...(outbound.image ? { image: outbound.image } : {}),
  };
}

/**
 * A message as this channel can show it: without a link button the link's URL goes on a line after
 * the text, and without images the text goes alone. So a provider only gets what it declared.
 */
export function fitMessage<M extends { text: string; link?: { label: string; url: string }; image?: { url: string } }>(info: ChannelInfo, message: M): M {
  const { link, image, ...rest } = message;
  return {
    ...rest,
    ...(link && !info.linkButton ? { text: `${message.text}\n${link.url}` } : {}),
    ...(link && info.linkButton ? { link } : {}),
    ...(image && info.images ? { image } : {}),
  } as M;
}

export function summarize(channel: Channel): ChannelSummary {
  return { name: channel.name, kind: channel.kind, info: channel.info };
}
