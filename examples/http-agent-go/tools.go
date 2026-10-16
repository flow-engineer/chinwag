// Pip's tools, over a tiny in-memory café (the same menu as examples/cafe/src/tools.ts).
package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

type menuItem struct {
	Item      string             `json:"item"`
	Sizes     map[string]float64 `json:"sizes"` // size to price in USD
	Milks     []string           `json:"milks"`
	Allergens []string           `json:"allergens"`
}

var menu = []menuItem{
	{"Latte", map[string]float64{"small": 4.0, "large": 4.8}, []string{"whole", "oat", "almond"}, []string{"dairy (unless plant milk)"}},
	{"Flat white", map[string]float64{"small": 4.2}, []string{"whole", "oat"}, []string{"dairy (unless oat)"}},
	{"Cold brew", map[string]float64{"small": 4.5, "large": 5.2}, []string{}, []string{}},
	{"Chai", map[string]float64{"small": 4.0, "large": 4.6}, []string{"whole", "oat"}, []string{"dairy (unless oat)"}},
	{"Almond croissant", map[string]float64{"one": 4.25}, []string{}, []string{"gluten", "nuts", "dairy", "egg"}},
	{"Banana bread", map[string]float64{"slice": 3.75}, []string{}, []string{"gluten", "egg", "walnuts"}},
}

// toolDefinitions are the tools as the model sees them (JSON Schema parameters).
var toolDefinitions = json.RawMessage(`[
  {"type": "function", "function": {
    "name": "get_menu",
    "description": "The full menu: items, sizes with prices in USD, milk options and allergens.",
    "parameters": {"type": "object", "properties": {}}}},
  {"type": "function", "function": {
    "name": "place_order",
    "description": "Place a confirmed pickup order. Returns the order number and when it will be ready.",
    "parameters": {"type": "object", "required": ["name", "items"], "properties": {
      "name": {"type": "string", "description": "The name for the order"},
      "items": {"type": "array", "items": {"type": "object", "required": ["item", "size"], "properties": {
        "item": {"type": "string"},
        "size": {"type": "string"},
        "milk": {"type": "string"},
        "quantity": {"type": "integer", "minimum": 1, "maximum": 20, "default": 1}}}}}}}}
]`)

type orderItem struct {
	Item     string `json:"item"`
	Size     string `json:"size"`
	Milk     string `json:"milk"`
	Quantity int    `json:"quantity"`
}

var (
	orderMu   sync.Mutex
	nextOrder = 1040
)

// runTool runs one tool call; a problem comes back to the model as {"error": ...}.
func runTool(name, arguments string) any {
	switch name {
	case "get_menu":
		return map[string]any{"menu": menu, "note": "This is the whole menu."}
	case "place_order":
		var input struct {
			Name  string      `json:"name"`
			Items []orderItem `json:"items"`
		}
		if err := json.Unmarshal([]byte(arguments), &input); err != nil {
			return map[string]string{"error": "Arguments are not valid JSON: " + err.Error()}
		}
		return placeOrder(input.Items)
	}
	return map[string]string{"error": "Unknown tool: " + name}
}

// placeOrder fails if an item, size or milk is not on the menu; else it numbers the order.
func placeOrder(items []orderItem) any {
	if len(items) == 0 {
		return map[string]string{"error": "The order has no items"}
	}
	for _, o := range items {
		if problem := offMenu(o); problem != "" {
			return map[string]string{"error": problem}
		}
	}
	orderMu.Lock()
	id := fmt.Sprintf("BL-%d", nextOrder)
	nextOrder++
	orderMu.Unlock()
	readyBy := time.Now().UTC().Add(10 * time.Minute).Format(time.RFC3339)
	return map[string]any{"order_id": id, "ready_by": readyBy, "pay_at_pickup": true}
}

func offMenu(o orderItem) string {
	for _, m := range menu {
		if !strings.EqualFold(m.Item, o.Item) {
			continue
		}
		if _, ok := m.Sizes[strings.ToLower(o.Size)]; !ok {
			return fmt.Sprintf("Unknown size for %s: %s", m.Item, o.Size)
		}
		if o.Milk != "" && !hasMilk(m, o.Milk) {
			return fmt.Sprintf("Unknown milk for %s: %s", m.Item, o.Milk)
		}
		if o.Quantity < 0 || o.Quantity > 20 {
			return fmt.Sprintf("Quantity must be 1 to 20, not %d", o.Quantity)
		}
		return ""
	}
	return "Unknown item: " + o.Item
}

func hasMilk(m menuItem, milk string) bool {
	for _, have := range m.Milks {
		if strings.EqualFold(have, milk) {
			return true
		}
	}
	return false
}
