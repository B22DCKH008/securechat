package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/securechat/backend/internal/auth"
	"github.com/securechat/backend/internal/domain"
	"github.com/securechat/backend/internal/service/keys"
)

// ---- auth (DEV ONLY) ----

func (a *api) devLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
	}
	if err := decodeJSON(r, &req); err != nil || len(req.Username) < 2 || len(req.Username) > 32 {
		writeError(w, a.Log, domain.ErrInvalidInput)
		return
	}
	uid, err := a.DevLogin(r.Context(), req.Username)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	tok, exp, err := a.Auth.Issue(uid)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": uid, "accessToken": tok, "expiresAt": exp})
}

// ---- conversations ----

func (a *api) listConversations(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	convs, err := a.Messaging.ListConversations(r.Context(), uid)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": convs})
}

func (a *api) createConversation(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	var req struct {
		PeerUserID uuid.UUID `json:"peerUserId"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	c, err := a.Messaging.CreateDirect(r.Context(), uid, req.PeerUserID)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// ---- messages ----

// history: GET /v1/conversations/{id}/messages?before_seq=&limit=  (cursor pagination, RS8)
func (a *api) history(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	convID, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	msgs, err := a.Messaging.History(r.Context(), uid, convID, queryInt(r, "before_seq", 0), int(queryInt(r, "limit", 50)))
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	var next *int64
	if len(msgs) > 0 {
		s := msgs[len(msgs)-1].Seq
		next = &s
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "nextBeforeSeq": next})
}

type sendRequest struct {
	ClientMessageID string          `json:"clientMessageId"`
	Ciphertext      []byte          `json:"ciphertext"`
	ProtocolMeta    json.RawMessage `json:"protocolMeta"`
	ClientCreatedAt *time.Time      `json:"clientCreatedAt,omitempty"`
}

// sendMessage: REST fallback for sending (same semantics as WS "send").
func (a *api) sendMessage(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	convID, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	var req sendRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	res, err := a.Messaging.Send(r.Context(), domain.SendCommand{
		SenderID: uid, ClientMessageID: req.ClientMessageID, ConversationID: convID,
		Ciphertext: req.Ciphertext, ProtocolMeta: req.ProtocolMeta, ClientCreatedAt: req.ClientCreatedAt,
	})
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	status := http.StatusCreated
	if res.Duplicate {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{
		"messageId": res.Message.ID, "clientMessageId": res.Message.ClientMessageID,
		"conversationId": res.Message.ConversationID, "seq": res.Message.Seq,
		"state": domain.StateAccepted, "duplicate": res.Duplicate,
	})
}

func (a *api) receipt(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	msgID, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	var req struct {
		State domain.DeliveryState `json:"state"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	if err := a.Messaging.Acknowledge(r.Context(), uid, msgID, req.State); err != nil {
		writeError(w, a.Log, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sync: POST /v1/sync {"cursors": {"<convId>": <lastSeenSeq>}, "limit": 100}  (RS4)
func (a *api) sync(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	var req struct {
		Cursors map[uuid.UUID]int64 `json:"cursors"`
		Limit   int                 `json:"limit"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	res, err := a.Messaging.Sync(r.Context(), uid, req.Cursors, req.Limit)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": res})
}

// ---- keys (Signal pre-key directory, public material only) ----

func (a *api) uploadKeys(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	var req keys.UploadRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	if err := a.Keys.Upload(r.Context(), uid, req); err != nil {
		writeError(w, a.Log, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) claimBundle(w http.ResponseWriter, r *http.Request) {
	peerID, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	deviceID, err := strconv.Atoi(r.PathValue("deviceId"))
	if err != nil {
		writeError(w, a.Log, domain.ErrInvalidInput)
		return
	}
	b, err := a.Keys.Claim(r.Context(), peerID, deviceID)
	if err != nil {
		writeError(w, a.Log, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}
