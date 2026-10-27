using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StowCards.Example;

// Only the fields this example reads are mapped; unknown fields are ignored,
// so new API fields never break deserialisation.

/// <summary>
/// Reads an optional field only when it has the JSON type the model expects (a string, or an
/// object); any other value counts as absent instead of failing the whole response.
/// </summary>
public sealed class OptionalConverter<T> : JsonConverter<T>
    where T : class
{
    public override T? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != (typeof(T) == typeof(string) ? JsonTokenType.String : JsonTokenType.StartObject))
        {
            reader.Skip();
            return null;
        }
        return JsonSerializer.Deserialize<T>(ref reader, options);
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, options);
}

/// <summary>A program as returned by <c>GET /merchants/me/programs</c>. Programs are keyed by <c>_id</c>.</summary>
public sealed record StowProgram(
    [property: JsonPropertyName("_id")] string Id,
    string? Name,
    string? Status,
    string? ProgramType,
    [property: JsonConverter(typeof(OptionalConverter<string>))] string? BalanceKey);

/// <summary>The compact program snapshot embedded in member responses. Unlike a program, it is keyed by <c>id</c>.</summary>
public sealed record ProgramSummary(
    string? Id,
    string? Name,
    string? ProgramType,
    [property: JsonConverter(typeof(OptionalConverter<string>))] string? BalanceKey);

public sealed record AppleWallet(string? PassUrl, string? Mode, bool? Installed);

public sealed record GoogleWallet(string? SaveUrl, string? Mode, bool? Installed);

public sealed record PassIssuance(bool Apple, bool Google);

/// <summary>
/// A member. <see cref="MemberCode"/> is the "Member ID" people see; <see cref="Id"/> is the UUID
/// used in API paths. <c>serialNumber</c> is wallet plumbing and is deliberately not mapped.
/// </summary>
public sealed record Member(
    string Id,
    string? MemberCode,
    string? FirstName,
    string? LastName,
    string? Email,
    string? Status,
    [property: JsonConverter(typeof(OptionalConverter<IReadOnlyDictionary<string, JsonElement>>))]
    IReadOnlyDictionary<string, JsonElement>? FieldValues,
    AppleWallet? Apple,
    GoogleWallet? Google,
    [property: JsonConverter(typeof(OptionalConverter<ProgramSummary>))] ProgramSummary? Program,
    PassIssuance? PassIssuance,
    bool? Deduped)
{
    /// <summary>
    /// The balance stored under <paramref name="balanceKey"/> only (no fallback to another key), or
    /// null when there is no whole number there. The API may send it as a number or as a numeric
    /// string such as <c>"0"</c>.
    /// </summary>
    public long? GetBalance(string balanceKey)
    {
        if (FieldValues is null || !FieldValues.TryGetValue(balanceKey, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)) return number;
        if (value.ValueKind == JsonValueKind.String &&
            long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }
        return null;
    }
}

public sealed record ApplePassUpdate(int? DevicesNotified, int? DevicesAttempted, string? Mode);

public sealed record GooglePassUpdate(bool? ObjectPatched, string? Mode);

/// <summary>
/// What happened to the wallet pass after a change. The pass serial is not mapped: it is wallet
/// plumbing, never the Member ID.
/// </summary>
public sealed record PassUpdateReport(string? LastUpdateTag, bool? Rebuilt, ApplePassUpdate? Apple, GooglePassUpdate? Google);

/// <summary><see cref="PassUpdate"/> is null when the pass service did not confirm the update; the balance change is saved regardless.</summary>
public sealed record PointsAdjustResult(Member? Member, long? Previous, long? Current, PassUpdateReport? PassUpdate);

public sealed record EnrollMemberRequest(
    string ProgramId,
    string FirstName,
    string LastName,
    string Email,
    string? Phone = null,
    int? InitialPoints = null);

/// <summary>Send exactly one of <see cref="Delta"/> (relative) or <see cref="Value"/> (absolute).</summary>
public sealed record AdjustPointsRequest(int? Delta = null, int? Value = null, string? ChangeMessage = null);
