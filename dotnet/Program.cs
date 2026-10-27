using System.Text.Json;
using StowCards.Example;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cts.Cancel();
};

StowClient stow;
try
{
    stow = StowClient.FromEnvironment();
}
catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
{
    return Fail($"Configuration error: {ex.Message}", 2);
}

using (stow)
{
    stow.Log = note => Console.WriteLine($"   ... {note}");
    try
    {
        return await RunAsync(stow, cts.Token);
    }
    catch (StowApiException ex) when (ex.Status == 0)
    {
        // No response arrived: CONNECTION_ERROR or TIMEOUT.
        return Fail($"Error: {ex.Code}: {ex.ApiMessage}", 1);
    }
    catch (StowApiException ex)
    {
        var requestId = ex.RequestId is null ? "" : $" (request id {ex.RequestId})";
        return Fail($"Error: {ex.Status} {ex.Code}: {ex.ApiMessage}{requestId}", 1);
    }
    catch (OperationCanceledException) when (cts.IsCancellationRequested)
    {
        return Fail("Cancelled.", 130);
    }
}

static async Task<int> RunAsync(StowClient stow, CancellationToken cancellationToken)
{
    Console.WriteLine($"Stow Cards API at {stow.BaseUrl}");

    // 1. Pick the first active program.
    var programs = await stow.ListProgramsAsync(cancellationToken);
    var program = programs.FirstOrDefault(p => p.Status == "active");
    foreach (var skipped in programs.TakeWhile(p => p != program))
    {
        Console.WriteLine($"   skipping \"{skipped.Name}\" ({skipped.Status})");
    }
    if (program is null)
    {
        return Fail(
            $"Error: none of the {programs.Count} programs is active. Publish one in the web console (Pass Designer) first.", 1);
    }
    Console.WriteLine($"1. Program: \"{program.Name}\" ({program.Id})");

    // 2. Enrol a fresh member. A repeat of the same (programId, email) returns the existing member.
    var email = $"dev+{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}@example.com";
    var enrolled = await stow.EnrollMemberAsync(
        new EnrollMemberRequest(program.Id, "Ada", "Lovelace", email, InitialPoints: 50),
        cancellationToken);
    Console.WriteLine(enrolled.Deduped == true
        ? $"2. {email} was already enrolled; the existing member was returned (deduped: true)"
        : $"2. Enrolled {email}");
    if (enrolled.PassIssuance is { } issuance && !(issuance.Apple && issuance.Google))
    {
        Console.WriteLine($"   note: passes issued: apple={issuance.Apple}, google={issuance.Google}");
    }

    // 3. Award 10 points. One Idempotency-Key for this gesture, reused on every retry of it.
    var idempotencyKey = Guid.NewGuid().ToString();
    var adjusted = await stow.AdjustPointsAsync(
        enrolled.Id,
        new AdjustPointsRequest(Delta: 10, ChangeMessage: "Thanks for visiting!"),
        idempotencyKey,
        cancellationToken);
    Console.WriteLine(
        $"3. Awarded 10 points: {adjusted.Previous?.ToString() ?? "n/a"} -> {adjusted.Current?.ToString() ?? "n/a"} (Idempotency-Key {idempotencyKey})");
    Console.WriteLine(adjusted.PassUpdate is { } update
        ? $"   pass update: apple {update.Apple?.Mode ?? "unknown"}, {update.Apple?.DevicesNotified ?? 0}/{update.Apple?.DevicesAttempted ?? 0} devices notified; " +
          $"google {update.Google?.Mode ?? "unknown"}, object patched: {(update.Google?.ObjectPatched == true ? "yes" : "no")}"
        : "   pass update: not confirmed by the pass service (the balance change is saved)");

    // 4. Read the member back.
    var member = await stow.GetMemberAsync(enrolled.Id, cancellationToken);
    // The balance key: the member's program snapshot, then the program from step 1, then "points".
    // Only that key is read, so another key's value is never shown under its name.
    var balanceKey = NonEmpty(member.Program?.BalanceKey) ?? NonEmpty(program.BalanceKey) ?? "points";
    Console.WriteLine("4. Member:");
    Console.WriteLine($"   Member ID     {member.MemberCode ?? "(none)"}");
    Console.WriteLine($"   Balance       {StoredValue(member, balanceKey)} ({balanceKey})");
    Console.WriteLine($"   Apple pass    {member.Apple?.PassUrl ?? "(not issued)"}");
    Console.WriteLine($"   Google pass   {member.Google?.SaveUrl ?? "(not issued)"}");
    Console.WriteLine($"   Wallet modes  apple={member.Apple?.Mode ?? "unknown"}, google={member.Google?.Mode ?? "unknown"}");
    if (member.Apple?.Mode == "stub" || member.Google?.Mode == "stub")
    {
        Console.WriteLine("   (stub: that wallet's credentials are not configured, so no update reaches a phone)");
    }
    return 0;
}

// A balance key is missing only when it is absent, not a string (Models.cs reads that as null) or empty;
// a key of spaces is used as it is.
static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

static string StoredValue(Member member, string key) =>
    member.FieldValues is null || !member.FieldValues.TryGetValue(key, out var value) || value.ValueKind == JsonValueKind.Null
        ? "n/a"
        : value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();

// Progress is already on stdout; an error goes to stderr after it, as one line.
static int Fail(string message, int exitCode)
{
    Console.Out.Flush();
    var flat = new string(message.Select(c => char.IsWhiteSpace(c) || char.IsControl(c) ? ' ' : c).ToArray());
    Console.Error.WriteLine(string.Join(' ', flat.Split(' ', StringSplitOptions.RemoveEmptyEntries)));
    return exitCode;
}
