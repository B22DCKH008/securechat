package domain

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestGroupSendValidation(t *testing.T) {
	sender, b, c := uuid.New(), uuid.New(), uuid.New()
	ok := SendCommand{SenderID: sender, ConversationID: uuid.New(), ClientMessageID: "g1",
		Ciphertexts: []RecipientCiphertext{{RecipientID: b, Ciphertext: []byte{1}}, {RecipientID: c, DeviceID: 1, Ciphertext: []byte{2}}}}
	if err := ok.Validate(64); err != nil {
		t.Fatalf("valid group send rejected: %v", err)
	}
	cases := map[string]func(*SendCommand){
		"both ciphertext forms": func(s *SendCommand) { s.Ciphertext = []byte{9} },
		"duplicate recipient":   func(s *SendCommand) { s.Ciphertexts[1].RecipientID = b },
		"sender as recipient":   func(s *SendCommand) { s.Ciphertexts[0].RecipientID = sender },
		"nil recipient":         func(s *SendCommand) { s.Ciphertexts[0].RecipientID = uuid.Nil },
		"empty copy":            func(s *SendCommand) { s.Ciphertexts[0].Ciphertext = nil },
		"negative device":       func(s *SendCommand) { s.Ciphertexts[0].DeviceID = -1 },
		"non-object meta":       func(s *SendCommand) { s.Ciphertexts[0].ProtocolMeta = json.RawMessage(`[1]`) },
		"total over budget":     func(s *SendCommand) { s.Ciphertexts[0].Ciphertext = bytes.Repeat([]byte{1}, 64) },
		"reserved client id":    func(s *SendCommand) { s.ClientMessageID = "sys:x" },
		"too many recipients": func(s *SendCommand) {
			s.Ciphertexts = nil
			for range MaxGroupMembers {
				s.Ciphertexts = append(s.Ciphertexts, RecipientCiphertext{RecipientID: uuid.New(), Ciphertext: []byte{1}})
			}
		},
	}
	for name, mutate := range cases {
		cmd := ok
		cmd.Ciphertexts = append([]RecipientCiphertext(nil), ok.Ciphertexts...)
		mutate(&cmd)
		if err := cmd.Validate(64); err != ErrInvalidInput {
			t.Errorf("%s: got %v", name, err)
		}
	}
	direct := SendCommand{SenderID: sender, ConversationID: uuid.New(), ClientMessageID: "d", Ciphertext: []byte{1}}
	if err := direct.Validate(64); err != nil || direct.IsGroup() {
		t.Fatal("direct send changed")
	}
	direct.Normalize()
	if string(direct.ProtocolMeta) != `{}` {
		t.Fatal("normalize meta")
	}
	ok.Normalize()
	if ok.Ciphertexts[0].DeviceID != 1 || string(ok.Ciphertexts[0].ProtocolMeta) != `{}` {
		t.Fatal("normalize copies")
	}
}

func TestValidGroupTitle(t *testing.T) {
	if got, ok := ValidGroupTitle("  Nhóm đồ án  "); !ok || got != "Nhóm đồ án" {
		t.Fatal("trim")
	}
	for _, bad := range []string{"", "   ", strings.Repeat("ă", MaxGroupTitle+1)} {
		if _, ok := ValidGroupTitle(bad); ok {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, ok := ValidGroupTitle(strings.Repeat("ă", MaxGroupTitle)); !ok {
		t.Fatal("rune length")
	}
}
