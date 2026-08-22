package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
)

// writeJSON renders an API response. Indentation and the absence of HTML
// escaping match what the API has always emitted, so anything diffing
// responses (or eyeballing curl output) sees no churn.
func (s *Server) writeJSON(w http.ResponseWriter, status int, payload any) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", " ")
	if err := encoder.Encode(payload); err != nil {
		s.logger.Error("encode response", "error", err)
		http.Error(w, `{"ok":false,"errors":["internal error"]}`, http.StatusInternalServerError)
		return
	}
	// Encoder#Encode appends a newline; the wire format never had one.
	body := bytes.TrimRight(buffer.Bytes(), "\n")

	header := w.Header()
	header.Set("content-type", "application/json; charset=utf-8")
	header.Set("content-length", strconv.Itoa(len(body)))
	header.Set("cache-control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}
