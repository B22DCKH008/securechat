package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestIssueVerify(t *testing.T) {
	iss := NewIssuer("0123456789abcdef0123456789abcdef", time.Minute)
	uid := uuid.New()
	tok, _, err := iss.Issue(uid)
	if err != nil {
		t.Fatal(err)
	}
	got, err := iss.Verify(tok)
	if err != nil || got != uid {
		t.Fatalf("verify: got %v err %v", got, err)
	}
}

func TestVerifyRejectsWrongSecretAndExpired(t *testing.T) {
	a := NewIssuer("0123456789abcdef0123456789abcdef", time.Minute)
	b := NewIssuer("ffffffffffffffffffffffffffffffff", time.Minute)
	tok, _, _ := a.Issue(uuid.New())
	if _, err := b.Verify(tok); err == nil {
		t.Fatal("expected wrong-secret rejection")
	}
	expired := NewIssuer("0123456789abcdef0123456789abcdef", -time.Minute)
	tok, _, _ = expired.Issue(uuid.New())
	if _, err := a.Verify(tok); err == nil {
		t.Fatal("expected expired rejection")
	}
}
