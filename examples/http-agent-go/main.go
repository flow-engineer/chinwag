// The café's agent, Pip, in Go with no dependencies, behind Chinwag's agent endpoint
// (spec/agent-endpoint.openapi.yaml): one POST per message from the person, answered with the
// replies to send. Its model is any OpenAI-compatible API; its tools run here, for real.
//
//	FAKE_MODEL=1 go run .     listens on http://localhost:3000/chinwag (PORT to change it), no key
//	npx chinwag test --agent-url http://localhost:3000/chinwag --synthetic     from this folder
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// request is one of the person's messages (spec/request.schema.json). Unknown fields are ignored:
// later versions may add optional ones.
type request struct {
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
	Channel        string `json:"channel"`
	Message        struct {
		Text    string `json:"text"`
		ReplyTo *struct {
			Text      string `json:"text"`
			FromAgent bool   `json:"fromAgent"`
		} `json:"replyTo"`
		Choice *struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"choice"`
		Attachments []struct {
			Kind string `json:"kind"`
			Mime string `json:"mime"`
			Name string `json:"name"`
			Data string `json:"data"`
		} `json:"attachments"`
	} `json:"message"`
}

type reply struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// chatMessage and toolCall are the chat completions API's messages.
type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// model is one call to the model: the conversation so far in, the assistant's next message out.
type model func(ctx context.Context, messages []chatMessage) (chatMessage, error)

const fakeReply = "Hi, I'm Pip at Bean & Leaf. What can I get you?"

func fakeModel(context.Context, []chatMessage) (chatMessage, error) {
	return chatMessage{Role: "assistant", Content: fakeReply}, nil
}

// The first key that is set picks the provider, as in Chinwag's own agents (src/model.ts).
var providers = []struct{ env, baseURL, model string }{
	{"OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "anthropic/claude-haiku-5.5"},
	{"OPENAI_API_KEY", "https://api.openai.com/v1", "gpt-6-luna"},
	{"ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/", "claude-haiku-5-5"},
	{"GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.8-flash"},
}

// openAICompatible calls {baseURL}/chat/completions with the café's tools. MODEL overrides the model id.
func openAICompatible() (model, error) {
	for _, p := range providers {
		key := strings.TrimSpace(os.Getenv(p.env))
		if key == "" {
			continue
		}
		id := p.model
		if named := strings.TrimSpace(os.Getenv("MODEL")); named != "" {
			id = named
		}
		url := strings.TrimSuffix(p.baseURL, "/") + "/chat/completions"
		client := &http.Client{Timeout: 60 * time.Second}
		return func(ctx context.Context, messages []chatMessage) (chatMessage, error) {
			body, _ := json.Marshal(map[string]any{"model": id, "messages": messages, "tools": toolDefinitions})
			req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
			if err != nil {
				return chatMessage{}, err
			}
			req.Header.Set("content-type", "application/json")
			req.Header.Set("authorization", "Bearer "+key)
			res, err := client.Do(req)
			if err != nil {
				return chatMessage{}, err
			}
			defer res.Body.Close()
			raw, _ := io.ReadAll(res.Body)
			if res.StatusCode != http.StatusOK {
				return chatMessage{}, fmt.Errorf("model answered %s: %.200s", res.Status, raw)
			}
			var out struct {
				Choices []struct {
					Message chatMessage `json:"message"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
				return chatMessage{}, fmt.Errorf("model answered with no message: %.200s", raw)
			}
			msg := out.Choices[0].Message
			msg.Role = "assistant"
			return msg, nil
		}, nil
	}
	return nil, errors.New("set one of OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY, or FAKE_MODEL=1 to run with no model")
}

type agent struct {
	model  model
	system string
	token  string

	mu        sync.Mutex
	histories map[string][]chatMessage // each conversation's messages, as kept per phone number
}

func newAgent(m model, system, token string) *agent {
	return &agent{model: m, system: system, token: token, histories: map[string][]chatMessage{}}
}

func (a *agent) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/chinwag" {
		http.NotFound(w, r)
		return
	}
	// Set CHINWAG_AGENT_TOKEN on both sides to require it.
	if a.token != "" && r.Header.Get("authorization") != "Bearer "+a.token {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ConversationID == "" {
		http.Error(w, "bad request: expected a Chinwag message as JSON", http.StatusBadRequest)
		return
	}
	text, err := a.turn(r.Context(), req)
	if err != nil {
		// Chinwag fails this turn and shows the reason.
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	replies := []reply{} // [] when there is nothing to say, never null
	if text != "" {
		replies = append(replies, reply{Type: "message", Text: text})
	}
	w.Header().Set("content-type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(map[string]any{"replies": replies})
}

// turn adds the person's message to the conversation, runs the model and its tools (up to 5
// steps), and returns the reply. A conversation's messages come one at a time, so only the map
// needs the lock.
func (a *agent) turn(ctx context.Context, req request) (string, error) {
	a.mu.Lock()
	history := append(a.histories[req.ConversationID], chatMessage{Role: "user", Content: personText(req)})
	a.histories[req.ConversationID] = history
	a.mu.Unlock()

	for step := 0; step < 5; step++ {
		msg, err := a.model(ctx, append([]chatMessage{{Role: "system", Content: a.system}}, history...))
		if err != nil {
			return "", err
		}
		if msg.Content != "" || len(msg.ToolCalls) > 0 {
			history = append(history, msg)
		}
		for _, call := range msg.ToolCalls {
			result, _ := json.Marshal(runTool(call.Function.Name, call.Function.Arguments))
			history = append(history, chatMessage{Role: "tool", ToolCallID: call.ID, Content: string(result)})
		}
		a.mu.Lock()
		a.histories[req.ConversationID] = history
		a.mu.Unlock()
		if len(msg.ToolCalls) == 0 {
			return strings.TrimSpace(msg.Content), nil
		}
	}
	return "", errors.New("the model was still calling tools after 5 steps")
}

// personText is the person's message as the model reads it: its id, then what they wrote, with a
// note for a tap, a quoted message or a file. File bytes are not sent to the model.
func personText(req request) string {
	m := req.Message
	tag := req.MessageID
	if m.Choice != nil {
		tag += ", tapped"
	}
	parts := []string{"[" + tag + "]"}
	if m.Text != "" {
		parts = append(parts, m.Text)
	}
	if q := m.ReplyTo; q != nil {
		whose := "your message"
		if !q.FromAgent {
			whose = "their own message"
		}
		parts = append(parts, fmt.Sprintf("(replying to %s %q)", whose, q.Text))
	}
	for _, f := range m.Attachments {
		kind := map[string]string{"image": "an image", "audio": "a voice note", "document": "a document"}[f.Kind]
		if kind == "" {
			kind = "a file"
		}
		name := f.Name
		if name == "" {
			name = f.Mime
		}
		parts = append(parts, fmt.Sprintf("(sent %s: %s)", kind, name))
	}
	return strings.Join(parts, " ")
}

func main() {
	system, err := os.ReadFile("../cafe/agent/AGENTS.md") // Pip's instructions, shared with the café example
	if err != nil {
		log.Fatalf("run this from examples/http-agent-go: %v", err)
	}
	m := model(fakeModel)
	if os.Getenv("FAKE_MODEL") != "1" {
		if m, err = openAICompatible(); err != nil {
			log.Fatal(err)
		}
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Listening on http://localhost:%s/chinwag\n", port)
	log.Fatal(http.Serve(listener, newAgent(m, string(system), os.Getenv("CHINWAG_AGENT_TOKEN"))))
}
