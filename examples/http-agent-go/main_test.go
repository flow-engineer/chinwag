package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPlaceOrderValidatesAgainstTheMenu(t *testing.T) {
	for _, c := range []struct {
		item orderItem
		want string
	}{
		{orderItem{Item: "Matcha latte", Size: "large"}, "Unknown item: Matcha latte"},
		{orderItem{Item: "Flat white", Size: "large"}, "Unknown size for Flat white: large"},
		{orderItem{Item: "Latte", Size: "large", Milk: "soy"}, "Unknown milk for Latte: soy"},
		{orderItem{Item: "Cold brew", Size: "small", Milk: "oat"}, "Unknown milk for Cold brew: oat"},
	} {
		got := placeOrder([]orderItem{{Item: "Latte", Size: "small"}, c.item})
		if got.(map[string]string)["error"] != c.want {
			t.Errorf("%+v: got %v, want error %q", c.item, got, c.want)
		}
	}
}

func TestPlaceOrderNumbersOrders(t *testing.T) {
	first := placeOrder([]orderItem{{Item: "latte", Size: "Large", Milk: "Oat", Quantity: 1}}).(map[string]any)
	second := placeOrder([]orderItem{{Item: "Banana bread", Size: "slice"}}).(map[string]any)
	a, errA := strconv.Atoi(strings.TrimPrefix(first["order_id"].(string), "BL-"))
	b, errB := strconv.Atoi(strings.TrimPrefix(second["order_id"].(string), "BL-"))
	if errA != nil || errB != nil || b != a+1 {
		t.Fatalf("order ids %v then %v, want BL- numbers going up by one", first["order_id"], second["order_id"])
	}
	ready, err := time.Parse(time.RFC3339, first["ready_by"].(string))
	if err != nil || ready.Sub(time.Now()) < 9*time.Minute || ready.Sub(time.Now()) > 11*time.Minute {
		t.Fatalf("ready_by %v, want about ten minutes from now", first["ready_by"])
	}
	if first["pay_at_pickup"] != true {
		t.Fatal("want pay_at_pickup")
	}
}

func post(t *testing.T, url, token, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/chinwag", strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(raw))
}

func TestEndpointWithTheFakeModel(t *testing.T) {
	server := httptest.NewServer(newAgent(fakeModel, "system", "t"))
	defer server.Close()
	msg := `{"conversationId":"whatsapp:s.c.whatsapp.1","messageId":"m1","channel":"whatsapp","message":{"text":"hi","newField":1},"later":true}`

	if status, _ := post(t, server.URL, "", msg); status != http.StatusUnauthorized {
		t.Fatalf("no token: status %d, want 401", status)
	}
	status, body := post(t, server.URL, "t", msg)
	want := `{"replies":[{"type":"message","text":"Hi, I'm Pip at Bean & Leaf. What can I get you?"}]}`
	if status != http.StatusOK || body != want {
		t.Fatalf("got %d %s, want 200 %s", status, body, want)
	}
	if status, _ := post(t, server.URL, "t", "{not json"); status != http.StatusBadRequest {
		t.Fatalf("bad JSON: status %d, want 400", status)
	}
}

// A scripted model: places an order through the tool loop, then says nothing on the next message.
func TestToolLoopHistoryAndEmptyReply(t *testing.T) {
	var seen [][]chatMessage
	scripted := func(_ context.Context, messages []chatMessage) (chatMessage, error) {
		seen = append(seen, messages)
		switch len(seen) {
		case 1:
			call := toolCall{ID: "c1", Type: "function"}
			call.Function.Name = "place_order"
			call.Function.Arguments = `{"name":"Sam","items":[{"item":"Latte","size":"large","milk":"oat"}]}`
			return chatMessage{Role: "assistant", ToolCalls: []toolCall{call}}, nil
		case 2:
			return chatMessage{Role: "assistant", Content: "Placed!"}, nil
		}
		return chatMessage{Role: "assistant"}, nil
	}
	server := httptest.NewServer(newAgent(scripted, "system", ""))
	defer server.Close()
	conv := `"conversationId":"whatsapp:s.order.whatsapp.1","channel":"whatsapp"`

	if _, body := post(t, server.URL, "", `{`+conv+`,"messageId":"m1","message":{"text":"yes"}}`); !strings.Contains(body, "Placed!") {
		t.Fatalf("first answer %s", body)
	}
	if tool := seen[1][len(seen[1])-1]; tool.Role != "tool" || tool.ToolCallID != "c1" || !strings.Contains(tool.Content, `"order_id":"BL-`) {
		t.Fatalf("tool result %+v", tool)
	}
	tap := `{` + conv + `,"messageId":"m2","message":{"text":"Oat","choice":{"title":"Oat"},"replyTo":{"text":"Which milk?","fromAgent":true},"attachments":[{"kind":"image","mime":"image/png","name":"photo.png","data":"iVBORw0KGgo="}]}}`
	if _, body := post(t, server.URL, "", tap); body != `{"replies":[]}` {
		t.Fatalf("empty answer %s, want {\"replies\":[]}", body)
	}
	last := seen[2]
	if len(last) != 6 { // system, m1, tool call, tool result, Placed!, m2
		t.Fatalf("history has %d messages, want 6", len(last))
	}
	if got, want := last[5].Content, `[m2, tapped] Oat (replying to your message "Which milk?") (sent an image: photo.png)`; got != want {
		t.Fatalf("person's message %q, want %q", got, want)
	}
}
