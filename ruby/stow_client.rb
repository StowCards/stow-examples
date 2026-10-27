# frozen_string_literal: true

# A small client for the Stow Cards public REST API, standard library only.
# Its retry and error rules are a simpler form of the official Node.js SDK's.
require "json"
require "net/http"
require "openssl"
require "securerandom"
require "time"
require "timeout"
require "uri"

# Base class of every error this client raises.
class StowError < StandardError
  # The text on one line: each run of whitespace or line breaks, Unicode ones
  # such as U+0085, U+2028 and U+2029 included, becomes one space.
  def self.one_line(text)
    text.to_s.b.force_encoding(Encoding::UTF_8).scrub.gsub(/[[:space:]]+/, " ").strip
  end
end

# Missing or invalid configuration: the API key or the base URL.
class StowConfigError < StowError; end

# The request never produced an HTTP response (DNS, refused or reset connection, TLS).
# #code is CONNECTION_ERROR, or TIMEOUT for a StowTimeoutError.
class StowConnectionError < StowError
  attr_reader :code

  def initialize(message, code: "CONNECTION_ERROR")
    @code = code
    super(StowError.one_line("#{code}: #{message}"))
  end
end

# An attempt did not finish within the timeout.
class StowTimeoutError < StowConnectionError
  def initialize(message)
    super(message, code: "TIMEOUT")
  end
end

# The API answered with an error. Branch on #code, show #api_message to people
# and quote #request_id to support.
class StowApiError < StowError
  attr_reader :status, :code, :api_message, :details, :request_id, :retry_after, :body

  def initialize(status:, code:, api_message:, details: {}, request_id: nil, retry_after: nil, body: nil)
    @status = status
    @code = code
    @api_message = api_message
    @details = details
    @request_id = request_id
    @retry_after = retry_after
    @body = body
    text = "#{status} #{code}: #{api_message}"
    text += " (request id #{request_id})" if request_id
    super(StowError.one_line(text))
  end
end

class StowClient
  DEFAULT_BASE_URL = "https://api.stow.cards/api/v1"
  USER_AGENT = "stowcards-example-ruby/1.0"
  # host.docker.internal is accepted only so this example can be checked from a
  # Docker container against a mock gateway running on the host.
  PLAIN_HTTP_HOSTS = %w[localhost 127.0.0.1 [::1] host.docker.internal].freeze
  IDEMPOTENCY_KEY_FORMAT = /\A[A-Za-z0-9_-]{8,128}\z/
  # Whitespace as JavaScript's String#trim sees it, so a key is trimmed as the
  # SDK trims it: ASCII spaces and line breaks, U+00A0, U+FEFF and the other
  # Unicode spaces.
  WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/
  SURROUNDING_SPACE = /\A#{WHITESPACE}+|#{WHITESPACE}+\z/
  # A JSON string as RFC 8259 writes it. Ruby's parser also accepts comments
  # and unknown escapes such as \x, which are not JSON, so a body with a
  # quote, a backslash or a "/" outside such strings is read as text.
  JSON_STRING = %r{"(?:[^"\\]++|\\["\\/bfnrt]|\\u\h{4})*+"}
  DELAY_SECONDS = /\A(?:[0-9]+\.?[0-9]*|\.[0-9]+)\z/
  MAX_RETRY_AFTER = 60
  RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504].freeze
  NETWORK_ERRORS = [Timeout::Error, SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError,
                    Net::HTTPBadResponse, Net::HTTPHeaderSyntaxError].freeze
  HTTP_METHODS = { get: Net::HTTP::Get, post: Net::HTTP::Post, patch: Net::HTTP::Patch }.freeze
  # The value as UTF-8 without surrounding whitespace. Bytes, such as an
  # environment value, are read as UTF-8 and a String in another encoding is
  # converted; anything that is not UTF-8 becomes U+FFFD.
  TRIM = lambda do |value|
    text = value.to_s
    unless [Encoding::UTF_8, Encoding::US_ASCII, Encoding::BINARY].include?(text.encoding)
      text = text.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
    end
    text.b.force_encoding(Encoding::UTF_8).scrub.gsub(SURROUNDING_SPACE, "")
  rescue Encoding::ConverterNotFoundError
    TRIM.call(text.b)
  end
  # The data shapes the flow depends on: programs need an "_id", members an
  # "id" that is not only whitespace, the same rule as a member id argument.
  NON_EMPTY_STRING = ->(value) { value.is_a?(String) && !value.empty? }
  NON_BLANK_STRING = ->(value) { value.is_a?(String) && !TRIM.call(value).empty? }
  PROGRAM_LIST = ->(data) { data.is_a?(Array) && data.all? { |p| p.is_a?(Hash) && NON_EMPTY_STRING.call(p["_id"]) } }
  # "." and ".." would resolve to another endpoint once placed in the path.
  MEMBER_ID = ->(value) { NON_BLANK_STRING.call(value) && !%w[. ..].include?(TRIM.call(value)) }
  MEMBER = ->(data) { data.is_a?(Hash) && MEMBER_ID.call(data["id"]) }
  private_constant :TRIM, :NON_EMPTY_STRING, :NON_BLANK_STRING, :PROGRAM_LIST, :MEMBER

  attr_reader :base_url

  # Reads STOW_API_KEY (required) and STOW_BASE_URL (optional).
  def self.from_env(**options)
    api_key = TRIM.call(ENV.fetch("STOW_API_KEY", ""))
    if api_key.empty?
      raise StowConfigError, "STOW_API_KEY is not set. Create a key in the Stow Cards console " \
                             "(Administration, API Keys) and export it as STOW_API_KEY."
    end
    base_url = TRIM.call(ENV.fetch("STOW_BASE_URL", ""))
    new(api_key: api_key, base_url: base_url.empty? ? DEFAULT_BASE_URL : base_url, **options)
  end

  # timeout: seconds each attempt may take, from connecting to the last byte of
  # the body. on_retry: optional callable that receives (retry_number,
  # max_retries, delay_seconds, reason) before each retry.
  def initialize(api_key:, base_url: DEFAULT_BASE_URL, timeout: 30, max_retries: 2, on_retry: nil)
    key = TRIM.call(api_key)
    raise StowConfigError, "The API key is empty." if key.empty?
    unless key.match?(/\A[\x21-\x7e]+\z/)
      raise StowConfigError, "The API key contains whitespace, control or non-ASCII characters."
    end
    unless max_retries.is_a?(Integer) && max_retries >= 0
      raise ArgumentError, "max_retries must be an Integer of 0 or more."
    end
    unless timeout.is_a?(Numeric) && timeout.real? && timeout.positive? && timeout.finite?
      raise ArgumentError, "timeout must be a positive number of seconds."
    end

    @base_url = normalise_base_url(base_url)
    @timeout = timeout
    @max_retries = max_retries
    @on_retry = on_retry
    # The key lives only in this closure, so no instance variable holds it and
    # inspect, YAML.dump and Marshal.dump (which raises) cannot show it.
    @sign = ->(req) { req["X-API-Key"] = key }
  end

  # Keeps the API key out of logs and error reports.
  def inspect
    "#<StowClient base_url=#{@base_url}>"
  end

  # Programs are raw records keyed by "_id"; members use "id".
  def list_programs
    request(:get, "/merchants/me/programs", expect: PROGRAM_LIST, what: "a list of programs that each have an _id")
  end

  # Dedupes on (programId, email), so a retry is safe: it returns the existing
  # member with "deduped" => true.
  def enroll_member(program_id:, first_name:, last_name:, email:, phone: nil, initial_points: nil)
    raise ArgumentError, "program_id must not be empty." if program_id.to_s.empty?

    body = { programId: program_id, firstName: first_name, lastName: last_name, email: email,
             phone: phone, initialPoints: initial_points }.compact
    request(:post, "/merchants/me/members", body: body, retryable: true, expect: MEMBER, what: "a member with an id")
  end

  def get_member(member_id)
    request(:get, "/merchants/me/members/#{segment(member_id)}", expect: MEMBER, what: "a member with an id")
  end

  # Pass exactly one of delta: or value:. Use one idempotency key per gesture
  # and pass the same key again if you retry that gesture yourself.
  def adjust_points(member_id, delta: nil, value: nil, change_message: nil, idempotency_key: SecureRandom.uuid)
    raise ArgumentError, "Pass exactly one of delta: or value:." if delta.nil? == value.nil?
    unless IDEMPOTENCY_KEY_FORMAT.match?(idempotency_key.to_s)
      raise ArgumentError, "idempotency_key must be 8 to 128 characters of [A-Za-z0-9_-]."
    end

    body = { delta: delta, value: value, changeMessage: change_message }.compact
    request(:patch, "/merchants/me/members/#{segment(member_id)}/points",
            body: body, idempotency_key: idempotency_key.to_s, retryable: true, expect: Hash)
  end

  # Sends one call and returns the envelope's "data" (nil for a 204). GET is
  # retried; other methods only when the caller marks the call as safe to
  # repeat. expect: Array, Hash or a predicate raises UNEXPECTED_RESPONSE for
  # other data; what: names the expected data in that error.
  def request(method, path, body: nil, idempotency_key: nil, retryable: method == :get, expect: nil, what: nil)
    attempts = retryable ? @max_retries + 1 : 1
    (1..attempts).each do |attempt|
      begin
        response, text = send_once(method, path, body, idempotency_key)
      rescue *NETWORK_ERRORS => e
        error = connection_error(e)
        raise error if attempt >= attempts

        pause(attempt, attempts, backoff(attempt), error.message)
        next
      end

      # The status decides first; only then is the body decoded.
      status = response.code.to_i
      if (300..399).cover?(status)
        raise unexpected(response, "UNEXPECTED_REDIRECT",
                         "The API answered with a redirect (#{status}), which this client does not follow. " \
                         "Check the base URL.")
      end
      return unwrap(response, text, expect, what) if (200..299).cover?(status)

      error = api_error(response, text)
      retry_allowed = attempt < attempts && retryable_error?(error, attempt, idempotency_key) &&
                      (error.retry_after.nil? || error.retry_after <= MAX_RETRY_AFTER)
      raise error unless retry_allowed

      pause(attempt, attempts, error.retry_after || backoff(attempt), "#{status} #{error.code}")
    end
  end

  private

  def send_once(method, path, body, idempotency_key)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + @timeout
    uri = URI.parse(@base_url + path)
    # Asking for identity stops Net::HTTP inflating gzip itself, so a corrupt
    # compressed body cannot escape as a Zlib error.
    req = HTTP_METHODS.fetch(method).new(uri, "Accept-Encoding" => "identity")
    @sign.call(req)
    req["Accept"] = "application/json"
    req["User-Agent"] = USER_AGENT
    req["Idempotency-Key"] = idempotency_key if idempotency_key
    unless body.nil?
      req["Content-Type"] = "application/json"
      req.body = JSON.generate(body)
    end
    # max_retries: 0 stops Net::HTTP from silently resending a GET after a
    # timeout or a reset, so every attempt is one request. open_timeout: nil
    # leaves connecting to the Timeout.timeout below: a second timer of the
    # same length could fire too and raise again after this client had raised.
    options = { use_ssl: uri.scheme == "https", open_timeout: nil,
                read_timeout: @timeout, write_timeout: @timeout, max_retries: 0 }
    # Net::HTTP does not follow redirects, so the key is never sent to another host.
    # Timeout.timeout covers what the socket timeouts cannot: the DNS lookup
    # (from Ruby 3.3), connecting, the TLS handshake and headers sent a byte
    # at a time.
    Timeout.timeout(@timeout) do
      Net::HTTP.start(uri.hostname, uri.port, **options) do |http|
        # The socket timeouts shrink to what is left of the attempt, before
        # sending and again after each piece of the body.
        http.read_timeout = http.write_timeout = time_left(deadline)
        text = String.new
        response = http.request(req) do |res|
          res.read_body do |chunk|
            text << chunk
            http.read_timeout = time_left(deadline)
          end
        end
        [response, text.force_encoding(Encoding::UTF_8)]
      end
    end
  end

  def time_left(deadline)
    left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
    raise Net::ReadTimeout if left <= 0

    left
  end

  # The client asks for identity, so a body under any other Content-Encoding
  # cannot be decoded: nil.
  def decoded(response, text)
    encoding = response["Content-Encoding"].to_s.strip.downcase
    encoding.empty? || encoding == "identity" ? text : nil
  end

  # The body as JSON whenever it parses as JSON, whatever its Content-Type,
  # else the text (invalid UTF-8 is never JSON). nil when blank.
  def parse(text)
    return text.scrub unless text.valid_encoding?
    return nil if TRIM.call(text).empty?
    return text if text.gsub(JSON_STRING, "").match?(%r{["\\/]})

    JSON.parse(text)
  rescue JSON::ParserError
    text
  end

  # A 2xx must be the API's {"success": true, "data": ...} envelope; a 204 has no data.
  def unwrap(response, text, expect, what)
    if response.code.to_i == 204
      parsed = { "success" => true }
    elsif (body = decoded(response, text))
      parsed = parse(body)
    else
      raise unexpected(response, "UNEXPECTED_RESPONSE", "The response body could not be decoded.")
    end
    unless parsed.is_a?(Hash) && parsed["success"] == true
      raise unexpected(response, "UNEXPECTED_RESPONSE",
                       "The response is not a Stow Cards API response. Check that the base URL " \
                       "points at the API, including /api/v1.", parsed)
    end
    data = parsed["data"]
    if expect && !(expect === data)
      what ||= expect == Array ? "a list" : "an object"
      raise unexpected(response, "UNEXPECTED_RESPONSE", "The response data is not #{what}.", parsed)
    end

    data
  end

  def unexpected(response, code, message, body = nil)
    StowApiError.new(status: response.code.to_i, code: code, api_message: message,
                     request_id: request_id(response), body: body)
  end

  # An empty or whitespace-only code or message counts as missing. A body
  # that is text, or a JSON string, gives the message; other JSON does not.
  def api_error(response, text)
    status = response.code.to_i
    body = decoded(response, text)
    parsed = body && parse(body)
    error = error_fields(parsed)
    code = NON_BLANK_STRING.call(error["code"]) ? error["code"] : "HTTP_#{status}"
    message = error["message"]
    unless NON_BLANK_STRING.call(message)
      message = parsed.is_a?(String) ? TRIM.call(parsed)[0, 500] : ""
      message = "Request failed with status #{status}" if message.empty?
    end
    StowApiError.new(
      status: status,
      code: code,
      api_message: message,
      details: error.except("code", "message"),
      request_id: request_id(response),
      retry_after: seconds(response["Retry-After"]),
      body: parsed
    )
  end

  # The API's {"error": {"code", "message", ...}} object, or the flat
  # {"error": message, "code": ...} that older gateways sent, read as the SDK
  # reads them.
  def error_fields(parsed)
    return {} unless parsed.is_a?(Hash)

    error = parsed["error"]
    return error if error.is_a?(Hash)

    error.is_a?(String) ? parsed.except("error", "success").merge("message" => error) : {}
  end

  # As UTF-8, so a header with non-ASCII bytes cannot break the error message.
  def request_id(response)
    id = TRIM.call(response["X-Correlation-Id"])
    id.empty? ? nil : id
  end

  def connection_error(exception)
    if exception.is_a?(Timeout::Error)
      StowTimeoutError.new("The attempt did not finish within #{@timeout} s.")
    else
      StowConnectionError.new("#{exception.message} (#{exception.class}).")
    end
  end

  # A 409 IDEMPOTENCY_KEY_IN_USE on a retry means our own earlier attempt still
  # holds the key, so waiting gets its stored answer. Any other 409, or one on
  # a first attempt, is a refusal.
  def retryable_error?(error, attempt, idempotency_key)
    return RETRYABLE_STATUSES.include?(error.status) unless error.status == 409

    !idempotency_key.nil? && attempt > 1 && error.code == "IDEMPOTENCY_KEY_IN_USE"
  end

  # Exponential backoff with full jitter: a random wait below a ceiling that
  # starts at 0.5 s and doubles per attempt, up to 8 s.
  def backoff(attempt)
    rand * [0.5 * (2**(attempt - 1)), 8.0].min
  end

  def pause(attempt, attempts, delay, reason)
    @on_retry&.call(attempt, attempts - 1, delay, reason)
    sleep(delay)
  end

  # Retry-After is delay-seconds ("5", "5.0", "5." or ".5", as the SDK's
  # Number() reads them, with no sign or exponent) or an HTTP date. Anything
  # else gives nil, so the normal backoff applies.
  def seconds(value)
    text = value.to_s.strip
    return text.to_f if text.match?(DELAY_SECONDS)

    [Time.httpdate(text) - Time.now, 0.0].max
  rescue ArgumentError
    nil
  end

  def segment(value)
    text = value.to_s
    raise ArgumentError, 'member_id must not be empty, only whitespace, "." or "..".' unless MEMBER_ID.call(text)

    URI.encode_www_form_component(text).gsub("+", "%20")
  end

  def normalise_base_url(value)
    text = TRIM.call(value)
    uri = URI.parse(text)
    host = uri.host.to_s.downcase
    unless %w[http https].include?(uri.scheme&.downcase) && !host.empty?
      raise StowConfigError, "The base URL (STOW_BASE_URL) must be an absolute https URL, such as #{DEFAULT_BASE_URL}."
    end
    if uri.scheme.casecmp?("http") && !(PLAIN_HTTP_HOSTS.include?(host) || host.match?(/\A([a-z0-9-]+\.)+localhost\z/))
      raise StowConfigError, "The base URL (STOW_BASE_URL) must use https. Plain http is allowed only for " \
                             "localhost, 127.0.0.1, [::1], *.localhost and host.docker.internal."
    end
    if uri.userinfo || text.match?(%r{\A[^/?#]*//[^/?#]*@}) || uri.query || uri.fragment
      raise StowConfigError, "The base URL (STOW_BASE_URL) must not contain credentials, a query or a fragment."
    end
    # URI reads an empty port ("localhost:") as the default port, so look at the text.
    empty_port = text[%r{\A[^:/?#]+://([^/?#]*)}, 1].to_s.end_with?(":")
    if empty_port || !(1..65_535).cover?(uri.port)
      raise StowConfigError, "The base URL (STOW_BASE_URL) has an invalid port."
    end

    uri.to_s.sub(%r{/+\z}, "").force_encoding(Encoding::UTF_8)
  rescue URI::InvalidURIError
    raise StowConfigError, "The base URL (STOW_BASE_URL) is not a valid URL."
  end
end
