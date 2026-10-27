// Package stow is a small client for the Stow Cards public REST API. It covers
// the four calls of the loyalty loop and follows the retry and error rules of
// the official Node.js SDK in a simpler form.
package stow

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// DefaultBaseURL is the production API, used when STOW_BASE_URL is unset.
const DefaultBaseURL = "https://api.stow.cards/api/v1"

// MaxRetries is how many times a failed attempt is repeated, at most.
const MaxRetries = 2

const (
	userAgent      = "stowcards-example-go/1.0"
	attemptTimeout = 30 * time.Second
	baseDelay      = 500 * time.Millisecond
	maxDelay       = 8 * time.Second
	maxRetryAfter  = 60 * time.Second
	maxBodyBytes   = 10 << 20
)

var (
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	delaySecondsPattern   = regexp.MustCompile(`^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$`)
)

// Client calls the API with one merchant's API key. Printing a Client with fmt
// never shows the key.
type Client struct {
	baseURL string
	key     *apiKey // a pointer to a string, which fmt prints as an address even field by field
	http    *http.Client

	// OnRetry, when set, is called before each retry with the failure that
	// caused it and the wait before the next attempt.
	OnRetry func(method, path string, retry int, wait time.Duration, cause error)
}

type apiKey string

// String hides the API key, for %v, %+v and %s.
func (c Client) String() string {
	return "stow.Client{baseURL: " + strconv.Quote(c.baseURL) + ", apiKey: [redacted]}"
}

// GoString hides the API key, for %#v.
func (c Client) GoString() string { return c.String() }

// NewClient returns a client for baseURL, such as DefaultBaseURL. The URL must
// use https; plain http is accepted only for a local gateway: localhost,
// 127.0.0.1, [::1], a .localhost name or host.docker.internal.
func NewClient(baseURL, apiKey string) (*Client, error) {
	key := trimSpace(apiKey)
	if err := checkKey(key); err != nil {
		return nil, fmt.Errorf("stow: the API key %w", err)
	}
	base, err := checkBaseURL(baseURL)
	if err != nil {
		return nil, fmt.Errorf("stow: the base URL %w", err)
	}
	return newClient(base, key), nil
}

// NewClientFromEnv reads STOW_API_KEY (required) and STOW_BASE_URL (optional).
// Its errors are configuration errors and never contain the key.
func NewClientFromEnv() (*Client, error) {
	key := trimSpace(os.Getenv("STOW_API_KEY"))
	if key == "" {
		return nil, errors.New("STOW_API_KEY is not set: create an API key in the web console (Administration > API Keys) and export it")
	}
	if err := checkKey(key); err != nil {
		return nil, fmt.Errorf("STOW_API_KEY %w", err)
	}
	raw := trimSpace(os.Getenv("STOW_BASE_URL"))
	if raw == "" {
		raw = DefaultBaseURL
	}
	base, err := checkBaseURL(raw)
	if err != nil {
		return nil, fmt.Errorf("STOW_BASE_URL %w", err)
	}
	return newClient(base, key), nil
}

func newClient(baseURL, key string) *Client {
	k := apiKey(key)
	return &Client{
		baseURL: baseURL,
		key:     &k,
		http: &http.Client{
			// Never follow a redirect, so the key is never sent to another host.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// checkKey accepts visible ASCII only. Its errors complete the sentence "the
// API key ..." and never quote the key.
func checkKey(key string) error {
	if key == "" {
		return errors.New("is required")
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7e {
			return errors.New("may contain only visible ASCII characters, with no spaces, line breaks or curly quotes: copy it again from the web console")
		}
	}
	return nil
}

// trimSpace removes the surrounding whitespace that JavaScript's trim()
// removes, as the Node.js SDK does: ASCII whitespace, the Unicode space
// separators (such as U+00A0, a no-break space), U+2028, U+2029 and U+FEFF.
func trimSpace(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', '\u2028', '\u2029', '\ufeff':
			return true
		}
		return unicode.Is(unicode.Zs, r)
	})
}

// checkBaseURL returns raw without trailing slashes. Its errors complete the
// sentence "the base URL ..." and never quote raw, which may hold a password.
func checkBaseURL(raw string) (string, error) {
	raw = strings.TrimRight(raw, "/")
	if strings.ContainsAny(raw, "?#") {
		return "", errors.New("must not contain a query (?) or a fragment (#)")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", errors.New("is not a URL such as " + DefaultBaseURL)
	}
	if u.User != nil {
		return "", errors.New("must not contain a user name or password")
	}
	if port := u.Port(); port != "" || strings.HasSuffix(u.Host, ":") {
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return "", errors.New("has an invalid port")
		}
	}
	// The host as written: an IPv6 address keeps its brackets, and one
	// without them (http://::1:80) is not a URL.
	host := strings.ToLower(u.Hostname())
	if strings.HasPrefix(u.Host, "[") {
		host = "[" + host + "]"
	} else if strings.Contains(host, ":") {
		return "", errors.New("is not a URL such as " + DefaultBaseURL)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLocalHost(host) {
			return "", errors.New("may use plain http only for localhost, 127.0.0.1, [::1], a .localhost name or host.docker.internal: use https")
		}
	default:
		return "", errors.New("must start with https://")
	}
	return u.String(), nil
}

// isLocalHost accepts the plain-http hosts as written: of the IPv6 addresses
// only the literal [::1], not another spelling of it.
func isLocalHost(host string) bool {
	switch host {
	case "localhost", "127.0.0.1", "[::1]", "host.docker.internal":
		return true
	}
	return strings.HasSuffix(host, ".localhost") && !slices.Contains(strings.Split(host, "."), "")
}

// Program is a pass program as GET /merchants/me/programs returns it. Programs
// are raw records keyed by "_id", unlike members.
type Program struct {
	ID          string `json:"_id"`
	Name        string `json:"name"`
	Status      string `json:"status"` // draft, active, paused or archived
	ProgramType string `json:"programType"`
	BalanceKey  string `json:"balanceKey"`
}

// ProgramSummary is the program snapshot inside a member detail, keyed by "id".
type ProgramSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ProgramType string `json:"programType"`
	BalanceKey  string `json:"balanceKey"`
}

// AppleWallet is the member's Apple Wallet pass. Mode is "real" or "stub".
type AppleWallet struct {
	PassURL   string `json:"passUrl"`
	Installed bool   `json:"installed"`
	Mode      string `json:"mode"`
}

// GoogleWallet is the member's Google Wallet pass. Mode is "real" or "stub".
type GoogleWallet struct {
	SaveURL   string `json:"saveUrl"`
	Installed bool   `json:"installed"`
	Mode      string `json:"mode"`
}

// Member holds the member fields this example uses. ID (a UUID) goes in API
// paths; MemberCode is the "Member ID", the only identifier to show people.
type Member struct {
	ID          string                     `json:"id"`
	MemberCode  string                     `json:"memberCode"`
	ProgramID   string                     `json:"programId"`
	FirstName   string                     `json:"firstName"`
	LastName    string                     `json:"lastName"`
	Email       string                     `json:"email"`
	Status      string                     `json:"status"`
	FieldValues map[string]json.RawMessage `json:"fieldValues"`
	Apple       AppleWallet                `json:"apple"`
	Google      GoogleWallet               `json:"google"`
}

// Balance reads a whole-number balance from FieldValues[key], which the API
// may send as a number or as a numeric string such as "0". A missing or null
// entry reports false.
func (m *Member) Balance(key string) (int64, bool) {
	raw, ok := m.FieldValues[key]
	if !ok || string(raw) == "null" {
		return 0, false
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return n, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil {
			return n, true
		}
	}
	return 0, false
}

// PassIssuance says which wallet links an enrolment issued.
type PassIssuance struct {
	Apple  bool `json:"apple"`
	Google bool `json:"google"`
}

// EnrolledMember is the answer to EnrollMember. Deduped is true when a member
// with that email already existed in the program and was returned instead.
type EnrolledMember struct {
	Member
	Deduped      bool          `json:"deduped"`
	PassIssuance *PassIssuance `json:"passIssuance"`
}

// MemberDetail is the answer to GetMember. Program is nil when the program
// has been deleted.
type MemberDetail struct {
	Member
	Program       *ProgramSummary `json:"program"`
	DeviceCount   int             `json:"deviceCount"`
	RedeemedCount int             `json:"redeemedCount"`
}

// EnrollRequest is the body of POST /merchants/me/members.
type EnrollRequest struct {
	ProgramID     string `json:"programId"`
	FirstName     string `json:"firstName"`
	LastName      string `json:"lastName"`
	Email         string `json:"email"`
	Phone         string `json:"phone,omitempty"`
	InitialPoints int    `json:"initialPoints,omitempty"`
}

// PointsChange is a relative balance change. The balance is clamped at 0.
type PointsChange struct {
	Delta         int    `json:"delta"`
	ChangeMessage string `json:"changeMessage,omitempty"`
}

// PointsResult is the answer to AdjustPoints. PassUpdate is nil when the pass
// service did not confirm the wallet update; the balance change is saved anyway.
type PointsResult struct {
	Member     Member      `json:"member"`
	Previous   int64       `json:"previous"`
	Current    int64       `json:"current"`
	PassUpdate *PassUpdate `json:"passUpdate"`
}

// PassUpdate reports what happened to the wallet pass after a change.
type PassUpdate struct {
	LastUpdateTag string `json:"lastUpdateTag"`
	Rebuilt       bool   `json:"rebuilt"`
	Apple         struct {
		DevicesNotified  int    `json:"devicesNotified"`
		DevicesAttempted int    `json:"devicesAttempted"`
		Mode             string `json:"mode"`
	} `json:"apple"`
	Google struct {
		ObjectPatched bool   `json:"objectPatched"`
		Mode          string `json:"mode"`
	} `json:"google"`
}

// ListPrograms returns the merchant's programs.
func (c *Client) ListPrograms(ctx context.Context) ([]Program, error) {
	var programs []Program
	if err := c.do(ctx, apiCall{method: http.MethodGet, path: "/merchants/me/programs"}, &programs); err != nil {
		return nil, err
	}
	return programs, nil
}

// EnrollMember enrols a customer. Enrolment dedupes on (programId, email), so
// a retried request cannot create a second member.
func (c *Client) EnrollMember(ctx context.Context, req EnrollRequest) (*EnrolledMember, error) {
	var member EnrolledMember
	call := apiCall{method: http.MethodPost, path: "/merchants/me/members", body: req, safeToRepeat: true}
	if err := c.do(ctx, call, &member); err != nil {
		return nil, err
	}
	return &member, nil
}

// AdjustPoints changes a member's balance. Use one idempotency key per
// gesture (see NewIdempotencyKey): the client resends it on its own retries,
// and you pass the same key again if you repeat the gesture yourself.
func (c *Client) AdjustPoints(ctx context.Context, memberID string, change PointsChange, idempotencyKey string) (*PointsResult, error) {
	if !validMemberID(memberID) {
		return nil, errMemberID
	}
	if !idempotencyKeyPattern.MatchString(idempotencyKey) {
		return nil, errors.New("stow: the idempotency key must be 8 to 128 characters of [A-Za-z0-9_-]")
	}
	var result PointsResult
	call := apiCall{
		method:         http.MethodPatch,
		path:           "/merchants/me/members/" + url.PathEscape(memberID) + "/points",
		body:           change,
		idempotencyKey: idempotencyKey,
		safeToRepeat:   true,
	}
	if err := c.do(ctx, call, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GetMember reads a member by its id (the UUID, not the Member ID).
func (c *Client) GetMember(ctx context.Context, memberID string) (*MemberDetail, error) {
	if !validMemberID(memberID) {
		return nil, errMemberID
	}
	var member MemberDetail
	if err := c.do(ctx, apiCall{method: http.MethodGet, path: "/merchants/me/members/" + url.PathEscape(memberID)}, &member); err != nil {
		return nil, err
	}
	return &member, nil
}

// NewIdempotencyKey returns a random UUID v4.
func NewIdempotencyKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// APIError is a failed API call that got a response. Branch on Code; show
// Message to people; quote RequestID (the X-Correlation-Id response header) to
// support. Besides the API's own codes, Code is UNEXPECTED_RESPONSE for an
// answer that is not the API's (or cannot be decoded), UNEXPECTED_REDIRECT for
// a 3xx, and HTTP_<status> when the error carries no code.
type APIError struct {
	Status     int
	Code       string
	Message    string
	Details    map[string]any // extra fields of the error object besides code and message
	RequestID  string
	RetryAfter time.Duration // from Retry-After, when the server sent one
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
	if e.RequestID != "" {
		s += " (request id " + e.RequestID + ")"
	}
	return s
}

// ConnectionError is a call that got no response: Code is TIMEOUT when the last
// attempt ran out of time, CONNECTION_ERROR otherwise.
type ConnectionError struct {
	Code    string
	Message string
	Err     error // the underlying network error
}

func (e *ConnectionError) Error() string { return e.Code + ": " + e.Message }

func (e *ConnectionError) Unwrap() error { return e.Err }

// apiCall is one call for do. A GET may be retried; any other method only
// when safeToRepeat says sending it twice cannot apply it twice, as for
// enrolment (which dedupes) and the points change under its Idempotency-Key.
type apiCall struct {
	method         string
	path           string
	body           any
	idempotencyKey string
	safeToRepeat   bool
}

// do sends one call, retrying network errors, timeouts and the statuses that
// shouldRetry accepts when the call may be retried at all.
func (c *Client) do(ctx context.Context, call apiCall, out any) error {
	method, path := call.method, call.path
	var payload []byte
	if call.body != nil {
		var err error
		if payload, err = json.Marshal(call.body); err != nil {
			return fmt.Errorf("stow: encode %s %s: %w", method, path, err)
		}
	}
	retryable := method == http.MethodGet || call.safeToRepeat
	for attempt := 0; ; attempt++ {
		res, err := c.send(ctx, method, path, payload, call.idempotencyKey)
		wait := backoff(attempt)
		var connErr *ConnectionError
		switch {
		case err == nil:
			data, apiErr := res.result()
			if apiErr == nil {
				return res.decode(data, out)
			}
			if !retryable || !shouldRetry(apiErr, call.idempotencyKey != "", attempt) {
				return apiErr
			}
			if d, ok := retryAfter(res.header); ok {
				if d > maxRetryAfter {
					return apiErr
				}
				wait = d
			}
			err = apiErr
		case ctx.Err() != nil:
			return fmt.Errorf("stow: %s %s: %w", method, path, ctx.Err())
		case !errors.As(err, &connErr) || !retryable:
			return err
		}
		if attempt >= MaxRetries {
			return err
		}
		if c.OnRetry != nil {
			c.OnRetry(method, path, attempt+1, wait, err)
		}
		if serr := sleep(ctx, wait); serr != nil {
			return fmt.Errorf("stow: %s %s: %w", method, path, serr)
		}
	}
}

type response struct {
	status     int
	header     http.Header
	body       []byte
	unreadable string // why the body could not be decoded, when it could not
}

func (c *Client) send(ctx context.Context, method, path string, payload []byte, idempotencyKey string) (*response, error) {
	ctx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("stow: %s %s: %w", method, path, err)
	}
	if payload != nil {
		// Without GetBody, net/http never resends the request by itself (it
		// would for a keyed PATCH on a reused connection), so every resend is
		// one of do's counted retries.
		req.GetBody = nil
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-API-Key", string(*c.key))
	req.Header.Set("Accept", "application/json")
	// Asking for gzip here, not leaving it to net/http, returns the raw body:
	// a failed read is then a network error, and a body that fails to decode
	// is UNEXPECTED_RESPONSE.
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("User-Agent", userAgent)
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	res, err := c.http.Do(req)
	if err == nil {
		defer res.Body.Close()
		var raw []byte
		if raw, err = io.ReadAll(io.LimitReader(res.Body, maxBodyBytes)); err == nil {
			r := &response{status: res.StatusCode, header: res.Header}
			r.body, r.unreadable = decodeBody(raw, res.Header.Get("Content-Encoding"))
			return r, nil
		}
	}
	call := method + " " + path
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &ConnectionError{Code: "TIMEOUT", Message: call + ": no complete response within " + attemptTimeout.String(), Err: err}
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return nil, &ConnectionError{Code: "CONNECTION_ERROR", Message: call + ": " + err.Error(), Err: err}
}

// decodeBody undoes a gzip Content-Encoding. When it cannot, unreadable says
// why: a 2xx then fails with UNEXPECTED_RESPONSE, and an error status is
// judged on its status alone.
func decodeBody(raw []byte, encoding string) (body []byte, unreadable string) {
	switch {
	case len(raw) == 0 || encoding == "" || strings.EqualFold(encoding, "identity"):
		return raw, ""
	case strings.EqualFold(encoding, "gzip"):
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err == nil {
			body, err = io.ReadAll(io.LimitReader(zr, maxBodyBytes))
		}
		if err != nil {
			return nil, "the response body could not be decoded: " + err.Error()
		}
		return body, ""
	}
	return nil, "the response uses Content-Encoding " + encoding + ", which this client cannot decode"
}

// result unwraps { "success": true, "data": ... } or returns an *APIError. The
// status decides first: a 3xx is a redirect whatever its body, and an error
// status keeps its status rules when its body cannot be decoded. A 204 is a
// success with no data.
func (r *response) result() (json.RawMessage, *APIError) {
	switch {
	case r.status >= 300 && r.status < 400:
		message := "the API answered with a redirect, which is not followed; check the base URL"
		if location := r.header.Get("Location"); location != "" {
			message = "the API answered with a redirect to " + location + ", which is not followed; check the base URL"
		}
		return nil, r.apiError("UNEXPECTED_REDIRECT", message)
	case r.status < 200 || r.status >= 300:
		return nil, r.statusError()
	case r.unreadable != "":
		return nil, r.apiError("UNEXPECTED_RESPONSE", r.unreadable)
	case r.status == http.StatusNoContent:
		return nil, nil
	}
	var env struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(r.body, &env) != nil || !env.Success {
		return nil, r.apiError("UNEXPECTED_RESPONSE",
			"the response is not a Stow Cards API success response; check that the base URL points at the API, including /api/v1")
	}
	return env.Data, nil
}

// decode fills out from data; out is nil for a call that expects no data.
func (r *response) decode(data json.RawMessage, out any) error {
	if out == nil {
		return nil
	}
	if len(data) == 0 || string(data) == "null" {
		return r.apiError("UNEXPECTED_RESPONSE", "the response carries no data")
	}
	if err := json.Unmarshal(data, out); err != nil {
		return r.apiError("UNEXPECTED_RESPONSE", "the response data does not have the expected shape: "+err.Error())
	}
	if why := missingID(out); why != "" {
		return r.apiError("UNEXPECTED_RESPONSE", why)
	}
	return nil
}

// missingID says which id the decoded data lacks, or "" when it has them all.
// JSON that leaves an id out (or sends null) decodes to "", which would
// otherwise reach a later request as an empty id. A member id that is only
// whitespace counts as missing too, as it does for AdjustPoints and GetMember.
var errMemberID = errors.New(`stow: the member id must not be empty, whitespace, "." or ".."`)

// validMemberID refuses ids that are empty or whitespace, and "." and "..",
// which would resolve to another endpoint once placed in the path.
func validMemberID(id string) bool {
	t := trimSpace(id)
	return t != "" && t != "." && t != ".."
}

func missingID(out any) string {
	member := "the member in the response data has no id"
	switch v := out.(type) {
	case *[]Program:
		for i, p := range *v {
			if p.ID == "" {
				return "program " + strconv.Itoa(i+1) + " in the response data has no _id"
			}
		}
	case *EnrolledMember:
		if !validMemberID(v.ID) {
			return member
		}
	case *MemberDetail:
		if !validMemberID(v.ID) {
			return member
		}
	}
	return ""
}

// apiError builds an error of the client's own for a response.
func (r *response) apiError(code, message string) *APIError {
	e := &APIError{Status: r.status, Code: code, Message: message, RequestID: r.header.Get("X-Correlation-Id")}
	if d, ok := retryAfter(r.header); ok {
		e.RetryAfter = d
	}
	return e
}

// statusError builds the error for an error status from its body, read as the
// Node.js SDK reads it. A code or message that is empty or only whitespace
// counts as missing.
func (r *response) statusError() *APIError {
	fields, text := errorBody(r.body)
	e := r.apiError("HTTP_"+strconv.Itoa(r.status), "Request failed with status "+strconv.Itoa(r.status))
	if s, ok := fields["code"].(string); ok && trimSpace(s) != "" {
		e.Code = s
	}
	if s, ok := fields["message"].(string); ok && trimSpace(s) != "" {
		e.Message = s
	} else if text = trimSpace(text); text != "" {
		e.Message = firstChars(text, 500)
	}
	delete(fields, "code")
	delete(fields, "message")
	if len(fields) > 0 {
		e.Details = fields
	}
	return e
}

// errorBody returns the error object of an error body: the documented
// {"error": {"code", "message", ...}}, or for the flat {"error": "message",
// "code": ...} of older gateways its other top-level fields with the message.
// A body that is not JSON (nil when it could not be decoded), or is a bare
// JSON string, comes back as text instead; any other JSON yields neither.
func errorBody(body []byte) (fields map[string]any, text string) {
	var value any
	if json.Unmarshal(body, &value) != nil {
		return nil, string(body)
	}
	switch v := value.(type) {
	case string:
		return nil, v
	case map[string]any:
		switch e := v["error"].(type) {
		case map[string]any:
			return e, ""
		case string:
			delete(v, "error")
			delete(v, "success")
			v["message"] = e
			return v, ""
		}
	}
	return nil, ""
}

func firstChars(s string, n int) string {
	if runes := []rune(s); len(runes) > n {
		return string(runes[:n])
	}
	return s
}

// shouldRetry says whether an API error is worth another attempt. attempt is
// the zero-based number of the attempt that got it.
func shouldRetry(e *APIError, hasIdempotencyKey bool, attempt int) bool {
	switch e.Status {
	case 408, 429, 500, 502, 503, 504:
		return true
	case 409:
		// On a retry, IDEMPOTENCY_KEY_IN_USE means our own earlier attempt
		// still holds the key: waiting lets it finish, and the next attempt
		// gets its stored answer. On a first attempt it is a real refusal.
		return hasIdempotencyKey && attempt > 0 && e.Code == "IDEMPOTENCY_KEY_IN_USE"
	}
	return false
}

// retryAfter reads a Retry-After header given in seconds (whole or decimal) or
// as an HTTP-date. Any other value is ignored, so the normal backoff applies.
func retryAfter(h http.Header) (time.Duration, bool) {
	const longest = 24 * time.Hour
	v := strings.TrimSpace(h.Get("Retry-After"))
	if delaySecondsPattern.MatchString(v) {
		seconds, _ := strconv.ParseFloat(v, 64) // too large a value parses as +Inf, which min caps
		return time.Duration(min(seconds, longest.Seconds()) * float64(time.Second)), true
	}
	if t, err := http.ParseTime(v); err == nil {
		return min(max(time.Until(t), 0), longest), true
	}
	return 0, false
}

// backoff is exponential backoff with full jitter: a random wait below
// 500 ms, 1 s, 2 s, ... capped at 8 s.
func backoff(attempt int) time.Duration {
	ceiling := min(maxDelay, baseDelay<<attempt)
	return time.Duration(mrand.Int64N(int64(ceiling)))
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
