// An agent you already have, wrapped for `chinwag test --agent-url`: one POST per message from the
// person, answered with the replies to send. No dependencies. Put your own agent where reply() is.
//
//   node server.mjs                 listens on http://localhost:3000/chinwag (PORT to change it)
//   npx chinwag test --agent-url http://localhost:3000/chinwag     from this folder, in another terminal

import { createServer } from "node:http";

/** Each conversation's messages, as your agent keeps them per phone number. */
const histories = new Map();

/** Your agent's turn: the person's message in, the replies out. Its tools run here, for real. */
async function reply(conversationId, channel, message) {
  const history = histories.get(conversationId) ?? [];
  histories.set(conversationId, history);
  history.push({ from: "person", text: message.text });
  const text = history.length === 1 ? "Hi! We're open 8am to 6pm every day. Can I help with anything else?" : "Happy to help. Have a good day!";
  history.push({ from: "agent", text });
  return [{ type: "message", text }];
}

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chinwag") return res.writeHead(404).end();
  // Set CHINWAG_AGENT_TOKEN on both sides to require it.
  const token = process.env.CHINWAG_AGENT_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
  let body = "";
  for await (const chunk of req) body += chunk;
  const { conversationId, channel, message } = JSON.parse(body);
  const replies = await reply(conversationId, channel, message);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ replies }));
}).listen(Number(process.env.PORT ?? 3000), () => console.log(`Listening on http://localhost:${process.env.PORT ?? 3000}/chinwag`));
