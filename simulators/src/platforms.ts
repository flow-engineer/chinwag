// What each chat platform can do, used by the simulators and the test harness, so an
// agent meets the same rules it would on the real platform. Nothing here sends real messages.
// SMS and WhatsApp are modelled in full; the others are being brought up to the same standard.

import type { ChannelInfo } from "../../src/index.ts";

export interface Platform extends ChannelInfo {
  id: "sms" | "whatsapp" | "imessage" | "telegram" | "web";
  name: string;
  /** Shows "typing…" while the agent works. Plain SMS has no typing indicator. */
  typing: boolean;
  /** SMS: texts are billed and split into segments (160 GSM-7 characters, 70 with Unicode). */
  segments?: boolean;
  /** SMS: the carrier answers STOP, START and HELP itself, and blocks texts after STOP. */
  carrierKeywords?: boolean;
  /** SMS: an iPhone's tapback reaches the agent as a text, like `Liked "…"`. */
  tapbacksAsText?: boolean;
  /** The person can react to the agent's messages (WhatsApp). */
  personReactions?: string[];
  /** The simulator models every feature and limit of the real platform. */
  complete: boolean;
  /** Simple Icons slug for the logo (cdn.simpleicons.org). */
  icon: string;
}

export const PLATFORMS: Platform[] = [
  {
    id: "sms",
    name: "SMS",
    reactions: false,
    status: false,
    typing: false,
    formatting: "plain",
    // Providers join up to 10 segments into one text: 1,530 GSM-7 characters.
    maxLength: 1530,
    segments: true,
    carrierKeywords: true,
    tapbacksAsText: true,
    complete: true,
    icon: "googlemessages",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    reactions: true,
    status: false,
    typing: true,
    formatting: "whatsapp",
    maxLength: 4096,
    replies: true,
    buttons: { max: 3, labelMax: 20 },
    lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
    linkButton: { labelMax: 20 },
    images: { captionMax: 1024 },
    readReceipts: true,
    personReactions: ["👍", "❤️", "😂", "😮", "😢", "🙏"],
    complete: true,
    icon: "whatsapp",
  },
  { id: "imessage", name: "iMessage", reactions: true, status: false, typing: true, formatting: "plain", images: { captionMax: 4000 }, complete: false, icon: "imessage" },
  { id: "telegram", name: "Telegram", reactions: true, status: false, typing: true, formatting: "markdown", images: { captionMax: 1024 }, complete: false, icon: "telegram" },
  { id: "web", name: "Web", reactions: true, status: true, typing: true, formatting: "markdown", linkButton: { labelMax: 20 }, images: { captionMax: 4000 }, complete: false, icon: "googlechrome" },
];

export function platform(id: string | null): Platform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
}

/** The parts of a platform the agent's runtime needs. */
export function channelOf(p: Platform): ChannelInfo {
  return {
    reactions: p.reactions,
    status: p.status,
    formatting: p.formatting,
    maxLength: p.maxLength,
    replies: p.replies,
    buttons: p.buttons,
    lists: p.lists,
    linkButton: p.linkButton,
    images: p.images,
    readReceipts: p.readReceipts,
  };
}

const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

/** How an SMS is split: its encoding, segment count, and characters left in the last segment. */
export function smsSegments(text: string): { encoding: "GSM-7" | "Unicode"; segments: number; remaining: number } {
  const gsm = GSM7.test(text);
  // GSM-7 extension characters take two septets.
  const length = gsm ? [...text].reduce((n, c) => n + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0) : [...text].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (length <= single) return { encoding: gsm ? "GSM-7" : "Unicode", segments: 1, remaining: single - length };
  const segments = Math.ceil(length / multi);
  return { encoding: gsm ? "GSM-7" : "Unicode", segments, remaining: segments * multi - length };
}
