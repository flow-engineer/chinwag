---
name: chinwag-auth
description: Set up sign-in so people can use a Chinwag agent's tools as themselves from Claude, ChatGPT, the CLI or a chat (OAuth for MCP, per-person grants, Firebase and Supabase, gating per tool). Load when tools need to know who the person is, when adding auth to a Chinwag MCP server or CLI, or when an organization's users must sign in.
---

# Sign-in for a Chinwag agent's tools

Read the `chinwag-context` skill first: `context/access.yaml` says which tasks need sign-in.

When a host (Claude, ChatGPT, the CLI) calls a tool that needs the person, it runs OAuth against
the organization's authorization server, with the person signing in **on the organization's own
pages**, never on a page you build elsewhere. The MCP server only checks the token on every
request and turns it into the person (`context.key`).

## The rule: the app mints, everyone else carries

The only credential the organization's backend trusts is one it minted itself: for one person and
one agent, with the scopes they approved, and revocable by the organization. Never hold a service
key that acts for every user, and never hand a person's own browser session to an agent. A host
carries the token and sends it with each call; nothing keeps it anywhere else.

## Pick the pattern from the stack

1. **Their identity provider already speaks OAuth 2.1** (Supabase Auth's OAuth server, Clerk,
   Auth0, Stytch, WorkOS, Descope, Okta, Keycloak). Turn on its OAuth server for agents: dynamic
   client registration or Client ID Metadata Documents (hosts register themselves; Claude prefers
   CIMD), PKCE, refresh tokens, and the scopes from `access.yaml`. Then point the server at it.
2. **Their login is a page and an SDK, not OAuth** (Firebase Auth, Cognito with its own UI,
   Auth.js, Devise, Django, Laravel, custom sessions). Add a **connect page** to their app: it uses
   their normal login and signup, shows what the agent asks for, and on approval their backend
   signs a **grant** with their own key. An OAuth front (on Flow, Flow's; self-hosted, an OAuth 2.1
   server library with the connect page as its login step) hands that grant to the host through a
   one-time code and a verifier only it knows, so the grant never appears in a browser URL.
3. **The tools run inside their backend.** Mount `mcpServer` in their existing server; `verify` is
   their existing token check, and tools use their own services directly. Tokens come from 1 or 2.

### The grant (pattern 2)

A JWT their backend signs, with a key pair whose public half they publish (a JWKS URL):

```json
{ "iss": "https://app.example.com", "sub": "<their user id>", "aud": "<the MCP server's URL>",
  "scope": "read write", "agent": "<the host's client id>", "jti": "<random id>", "exp": 1767225600 }
```

- Their API accepts it beside their normal tokens: it checks the signature with its own public
  key, `aud`, `exp`, and that `jti` is not revoked.
- Revocation is theirs: a "Connected apps" list on the person's account page with Disconnect,
  which revokes the `jti`; and the same when they delete or block a user.
- It is separate from the browser's session: signing out of the website does not disconnect Claude.

### Firebase: one function, no API

The database and its rules are the API, so the tools read and write Firestore as the person, and
the rules decide:

- One Cloud Function, `mintAgentToken`, called from the connect page by the signed-in user. With
  the Admin SDK it makes a custom token for that user with the agent's claims:
  `getAuth().createCustomToken(uid, { agent: "claude", scope: "read" })`. Exchanged, it is the
  agent's own Firebase session, apart from the browser's; it ends when the user is deleted or
  disabled, or changes their password or email.
- Rules can tell agents apart: `allow write: if request.auth.token.scope == "write";`, or no
  writes for agents at all.
- Write rules tests for the agent's claims with the Firebase emulator
  (`@firebase/rules-unit-testing`): an agent with `scope: "read"` cannot write; one person's agent
  cannot read another's data. Many apps' rules are looser than they look.

### Supabase

Its OAuth 2.1 server is pattern 1: no function needed. Row-level security is the permission model;
add policies for agent tokens if their scopes should allow less than the person's own session.

## Wire it into the agent

```ts
import { mcpServer } from "chinwag/mcp";
import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = createRemoteJWKSet(new URL("https://app.example.com/.well-known/jwks.json"));

export const mcp = mcpServer({
  name: "acme", version: "1.0.0", tools, dir: "agent",
  auth: {
    issuer: "https://login.example.com",          // where hosts go to sign in
    resource: "https://acme.example.com/mcp",     // this server's public URL
    scopes: { read: "read", write: "write" },     // reads need read, writes need write
    async verify(token) {                         // every request: who it is, or null
      try {
        const { payload } = await jwtVerify(token, keys, { audience: "https://acme.example.com/mcp" });
        return { key: String(payload.sub), scopes: String(payload.scope ?? "").split(" ") };
      } catch {
        return null;
      }
    },
  },
});
```

- Each tool says what it needs with `signIn` and `hints` (the `chinwag-tools` skill):
  `signIn: "none"` for what anyone may do signed out (the menu, opening hours), `"optional"` for
  what does more when signed in, and the default `"required"` for everything else.
  `hints.readOnly: true` tools need the `read` scope, the rest `write`.
- A call that needs sign-in and has none gets HTTP 401 with `WWW-Authenticate` pointing at the
  server's protected-resource metadata (served at `/.well-known/oauth-protected-resource/mcp`);
  hosts show their Connect prompt on that and retry. A token without a needed scope gets 403
  `insufficient_scope`. Never answer "please sign in" as a tool result: hosts do not start sign-in
  on it.
- In tools, the person is `context.key` (their user id from the token) and `context.person` is
  `key:<it>`. If the chat agent's `resolve` returns the same id for a WhatsApp number, the person is
  one person on both.
- The CLI signs in the same way: `acme auth login` runs this OAuth with a loopback redirect, and
  CI uses a token in `ACME_TOKEN`.

ChatGPT's support for asking to sign in partway through (some tools signed out, some not) is not
reliable yet: test it in ChatGPT itself before relying on it.
