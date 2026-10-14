// The shapes every part of Chinwag shares: chat history, the model contract, what a channel is sent.

export interface ToolCall {
  id: string;
  name: string;
  /** The model's arguments as it wrote them (a JSON string). */
  arguments: string;
}

export type ChatMessage =
  | { role: "user"; content: string; media?: Media[] }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/**
 * A photo or PDF in the person's messages, for the model to read. `data` (base64) is held in memory
 * only while the model is shown it, never stored; without it, the model is told it is no longer shown.
 */
export interface Media {
  kind: "image" | "document";
  mime: string;
  name?: string;
  data?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Aborted when the step is no longer wanted (the person sent another message). */
  signal: AbortSignal;
}

export interface ModelResponse {
  /** Text outside any tool call. Never shown to the person; kept in history as the agent's note. */
  text: string | null;
  toolCalls: ToolCall[];
  /** costUsd when the provider reports it (OpenRouter does). */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** The model that answered, as the provider names it. */
  model?: string;
}

/** Any model behind Chinwag. `complete` must reject promptly when `signal` aborts. */
export interface Model {
  complete(request: ModelRequest): Promise<ModelResponse>;
  /** What it reads besides text, as `media` on the person's messages. Without it: text only, and a note for each photo or PDF. */
  reads?: { images?: boolean; pdfs?: boolean };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** What a conversation sends to its channel. */
export type Outbound =
  | {
      type: "message";
      text: string;
      /** The person's message this one quotes (channels with replies). */
      replyTo?: string;
      /** Reply buttons; a tap comes back as the person's message. */
      buttons?: string[];
      /** A list the person picks one row from. */
      list?: { button: string; rows: ListRow[] };
      /** A button that opens this https page; only on channels with linkButton (elsewhere Chinwag puts the URL in the text). */
      link?: { label: string; url: string };
      /** A photo by https URL, the text its caption; only on channels with images (elsewhere the text goes alone). */
      image?: { url: string };
      /** The channel's own params (see Channel.params), as the agent filled them in. */
      fields?: Record<string, unknown>;
    }
  /** The agent has picked these messages up (WhatsApp's blue ticks). */
  | { type: "read"; messageIds: string[] }
  /** A reaction on one of the person's messages, by the id Chinwag gave it. */
  | { type: "reaction"; emoji: string; messageId: string }
  /** A template the owner set up with the channel (WhatsApp), sent as is, even outside its window. */
  | { type: "template"; name: string; language?: string; variables?: Record<string, string> }
  /** A short line of what the agent is doing, shown in the loading indicator; null clears it. */
  | { type: "status"; text: string | null }
  | { type: "typing"; on: boolean };

/** Sends one outbound; a rejection means it did not reach the person. */
export type Deliver = (outbound: Outbound) => Promise<void> | void;

/** What the channel a conversation is on can show. */
export interface ChannelInfo {
  /** Reactions on the person's message (WhatsApp, iMessage, web); plain SMS has none. */
  reactions: boolean;
  /** A live status line in the loading indicator (web and app UIs). */
  status: boolean;
  /** How text is formatted: none (SMS shows markdown raw), WhatsApp's own marks, or Markdown. */
  formatting?: "plain" | "whatsapp" | "markdown";
  /** The most characters one message can carry. */
  maxLength?: number;
  /** A message can quote one of the person's messages. */
  replies?: boolean;
  /** Reply buttons under a message. */
  buttons?: { max: number; labelMax: number };
  /** A list the person picks one row from. */
  lists?: { maxRows: number; titleMax: number; buttonMax: number };
  /** One button under a message that opens a web page (WhatsApp's call-to-action URL button). */
  linkButton?: { labelMax: number };
  /** Photos sent by URL, with the message's text as their caption. */
  images?: { captionMax: number };
  /** The channel shows the person when their message has been read. */
  readReceipts?: boolean;
  /**
   * The business may message first only this many hours after the person's last message
   * (WhatsApp: 24); after that, only templates.
   */
  replyWindowHours?: number;
}

/** A message from the person, with what the channel knows about it. */
export interface Incoming {
  text: string;
  /** The message they replied to (theirs or the agent's), quoted. */
  replyTo?: { text: string; fromAgent: boolean };
  /** They tapped a button or picked a list row rather than typing. */
  choice?: { id?: string; title: string };
  /** Photos, voice notes and documents sent with it; `text` is then their caption, or "". */
  attachments?: Attachment[];
}

/** A file the person sent. Its bytes are fetched only when the agent can use them. */
export interface Attachment {
  kind: "image" | "audio" | "document";
  mime: string;
  /** The file name, when the channel gives one (documents). */
  name?: string;
  /** The bytes. A provider fetches its media here with its own credentials: no URL reaches the model. */
  data(): Promise<Uint8Array>;
}

/** Turns a voice note into text, with whatever speech-to-text the agent's author chose. */
export type Transcribe = (audio: { mime: string; data: Uint8Array }) => Promise<string>;
