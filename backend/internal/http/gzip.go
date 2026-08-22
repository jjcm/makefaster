package httpapi

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
)

// gzipMinBytes skips compressing responses too small to benefit; the
// site-leaderboard JSON, on the other hand, is hundreds of kilobytes.
const gzipMinBytes = 1024

var compressibleTypes = []string{
	"text/", "application/json", "application/javascript", "image/svg+xml",
}

// gzipMiddleware compresses text responses for clients that asked for it.
// Range requests are passed through untouched: the byte offsets a client asked
// for refer to the identity encoding.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("accept-encoding"), "gzip") || r.Header.Get("range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		writer := &gzipResponseWriter{ResponseWriter: w}
		defer writer.Close()
		next.ServeHTTP(writer, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gzip        *gzip.Writer
	wroteHeader bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true

	header := w.Header()
	if hasBody(status) && shouldCompress(header) {
		// The compressed length is unknown until the body is written, and a
		// gzipped body invalidates byte ranges computed over the original.
		header.Del("content-length")
		header.Del("accept-ranges")
		header.Set("content-encoding", "gzip")
		header.Add("vary", "accept-encoding")
		w.gzip = gzip.NewWriter(w.ResponseWriter)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.gzip != nil {
		return w.gzip.Write(body)
	}
	return w.ResponseWriter.Write(body)
}

func (w *gzipResponseWriter) Close() {
	if w.gzip != nil {
		w.gzip.Close()
		w.gzip = nil
	}
}

// hasBody excludes the statuses that must not carry one: gzip's own framing
// bytes would be a protocol violation on a 204 or 304.
func hasBody(status int) bool {
	return status != http.StatusNoContent && status != http.StatusNotModified && status >= 200
}

func shouldCompress(header http.Header) bool {
	if header.Get("content-encoding") != "" {
		return false
	}
	if size, err := strconv.Atoi(header.Get("content-length")); err == nil && size < gzipMinBytes {
		return false
	}
	contentType := header.Get("content-type")
	for _, prefix := range compressibleTypes {
		if strings.HasPrefix(contentType, prefix) {
			return true
		}
	}
	return false
}
