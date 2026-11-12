package config

import "testing"

func TestWebSocketBudgetConfiguration(t *testing.T) {
	t.Setenv("JWT_SECRET", "012345678901234567890123456789012345")
	t.Setenv("WS_MAX_MESSAGE_BYTES", "65536")
	t.Setenv("WS_MAX_FRAME_BYTES", "")
	c, err := Load()
	if err != nil || c.WSMaxFrameBytes != 131072 || c.WSMaxMessageBytes != 65536 {
		t.Fatalf("default budgets: %+v, %v", c, err)
	}
	for _, size := range []string{"-1", "0", "8192", "65536", "95575"} {
		t.Setenv("WS_MAX_FRAME_BYTES", size)
		if _, err := Load(); err == nil {
			t.Fatalf("accepted insufficient frame budget %s", size)
		}
	}
	t.Setenv("WS_MAX_FRAME_BYTES", "95576") // 4*ceil(65536/3) + 8192
	if _, err := Load(); err != nil {
		t.Fatalf("exact minimum rejected: %v", err)
	}
	t.Setenv("WS_MAX_MESSAGE_BYTES", "131072")
	if _, err := Load(); err == nil {
		t.Fatal("accepted larger ciphertext without larger frame budget")
	}
	t.Setenv("WS_MAX_FRAME_BYTES", "196608")
	if _, err := Load(); err != nil {
		t.Fatalf("custom budgets: %v", err)
	}
}

func TestRejectUnsafeAuthAndRelayConfiguration(t *testing.T) {
	t.Setenv("JWT_SECRET", "012345678901234567890123456789012345")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Config){func(c *Config) { c.JWTSecret = "change-me-change-me-change-me-change-me" }, func(c *Config) { c.JWTTTL = 0 }, func(c *Config) { c.PostgresMaxConns = 1 }, func(c *Config) { c.RelayPollInterval = 0 }, func(c *Config) { c.WSPingInterval = 0 }} {
		invalid := c
		mutate(&invalid)
		if invalid.validate() == nil {
			t.Fatal("unsafe config accepted")
		}
	}
}
