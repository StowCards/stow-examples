# frozen_string_literal: true

# The Stow Cards loyalty loop in four calls: list programs, enroll a member,
# award points and read the member back.
#
#   STOW_API_KEY=stow_... ruby demo.rb
require "securerandom"
require_relative "stow_client"

$stdout.sync = true

def show(label, value)
  puts format("   %-15s%s", "#{label}:", value)
end

def wallet_line(url, mode)
  "#{url || "(not issued)"} (mode: #{mode || "unknown"})"
end

# A field the demo reads into, or {} when the API sent something else.
def object(value)
  value.is_a?(Hash) ? value : {}
end

# Configuration errors exit 2, API and connection errors exit 1.
def fail_with(message, status)
  $stdout.flush
  warn message
  exit status
end

begin
  stow = StowClient.from_env(
    on_retry: lambda do |retry_number, max_retries, delay, reason|
      puts format("   retry %d/%d in %.2f s after %s", retry_number, max_retries, delay, reason)
    end
  )
  puts "Stow Cards API at #{stow.base_url}"

  # The client checks that every program has an "_id" and every member an "id".
  programs = stow.list_programs
  program = programs.find { |p| p["status"] == "active" }
  unless program
    fail_with("Error: none of the #{programs.size} programs on this merchant is active. " \
              "Publish a program in the Stow Cards console (Pass Designer), then run this again.", 1)
  end
  puts %(1. Programs: #{programs.size} found, using "#{program["name"]}" (#{program["_id"]}))

  email = "dev+#{Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond)}@example.com"
  enrolled = stow.enroll_member(program_id: program["_id"], first_name: "Ada", last_name: "Lovelace",
                                email: email, initial_points: 50)
  member_id = enrolled["id"]
  note = enrolled["deduped"] ? " (deduped: true, the existing member was returned)" : ""
  puts "2. Enrolled #{email}#{note}"

  # One key for this gesture; the client resends the same key on every retry.
  idempotency_key = SecureRandom.uuid
  result = stow.adjust_points(member_id, delta: 10, change_message: "Thanks for visiting!",
                                         idempotency_key: idempotency_key)
  puts "3. Awarded 10 points: #{result["previous"]} -> #{result["current"]} (Idempotency-Key #{idempotency_key})"

  member = stow.get_member(member_id)
  # The balance key comes from the member's program snapshot, then the program
  # picked in step 1, then "points". Only that key's value is shown.
  balance_key = [object(member["program"])["balanceKey"], program["balanceKey"]]
                .find { |key| key.is_a?(String) && !key.empty? } || "points"
  balance = object(member["fieldValues"])[balance_key]
  apple = object(member["apple"])
  google = object(member["google"])

  puts "4. Member read back"
  show "Member ID", member["memberCode"] || "(none, enrolled before Member IDs existed)"
  show "Balance", "#{balance.nil? ? "n/a" : balance} #{balance_key}"
  show "Apple Wallet", wallet_line(apple["passUrl"], apple["mode"])
  show "Google Wallet", wallet_line(google["saveUrl"], google["mode"])
  if [apple["mode"], google["mode"]].include?("stub")
    puts "   Stub mode: the server has no wallet credentials for this pass, so updates do not reach a device."
  end
rescue StowConfigError => e
  fail_with("Configuration error: #{e.message}", 2)
rescue StowError => e
  fail_with("Error: #{e.message}", 1)
end
