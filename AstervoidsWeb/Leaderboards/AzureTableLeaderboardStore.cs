using System.Text.Json;
using AstervoidsWeb.Identity;
using Azure;
using Azure.Data.Tables;

namespace AstervoidsWeb.Leaderboards;

internal sealed class AzureTableLeaderboardStore(TableClient table) : ILeaderboardStore
{
    internal const int MaximumQueryPages = 8;
    private const int MaximumPayloadCharacters = 4096;
    private static readonly string[] QueryColumns = ["PartitionKey", "RowKey", "Timestamp", "Payload"];

    public async Task<LeaderboardRecord?> ReadAsync(
        Guid playerId, Guid runId, CancellationToken cancellationToken)
    {
        try
        {
            var key = LeaderboardRows.CanonicalKey(playerId, runId);
            var response = await table.GetEntityAsync<TableEntity>(
                LeaderboardRows.PartitionKey, key, cancellationToken: cancellationToken);
            var record = Decode(response.Value);
            if (response.Value.RowKey != key || LeaderboardRows.CanonicalKey(record) != key)
                throw new LeaderboardStoreUnavailableException();
            return record with { StorageEtag = response.Value.ETag.ToString() };
        }
        catch (RequestFailedException exception) when (IsMissingEntity(exception))
        {
            return null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new LeaderboardStoreUnavailableException();
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new LeaderboardStoreUnavailableException();
        }
    }

    public async Task<bool> TryCommitAsync(
        LeaderboardRecord? previous, LeaderboardRecord next, CancellationToken cancellationToken)
    {
        try
        {
            var writes = LeaderboardRows.Plan(previous, next);
            var payload = JsonSerializer.Serialize(next, IdentityJson.Options);
            var canonicalKey = LeaderboardRows.CanonicalKey(next);
            var actions = writes.Select(write =>
            {
                var entity = new TableEntity(LeaderboardRows.PartitionKey, write.Key);
                if (write.Record is not null)
                    entity["Payload"] = payload;
                // Index replacements/deletes are guarded by the canonical CAS
                // in this same transaction; overlap is a replace, never delete+add.
                return write.Kind switch
                {
                    LeaderboardWriteKind.Add => new TableTransactionAction(TableTransactionActionType.Add, entity),
                    LeaderboardWriteKind.Delete => new TableTransactionAction(TableTransactionActionType.Delete, entity, ETag.All),
                    _ => new TableTransactionAction(TableTransactionActionType.UpdateReplace, entity,
                        write.Key == canonicalKey ? new ETag(previous!.StorageEtag!) : ETag.All)
                };
            }).ToArray();
            await table.SubmitTransactionAsync(actions, cancellationToken);
            return true;
        }
        catch (RequestFailedException exception) when (
            exception.Status is 409 or 412 || IsMissingEntity(exception))
        {
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new LeaderboardStoreUnavailableException();
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new LeaderboardStoreUnavailableException();
        }
    }

    public async Task<IReadOnlyList<LeaderboardRecord>> QueryAsync(
        LeaderboardQueryRequest query, int limit, CancellationToken cancellationToken)
    {
        try
        {
            LeaderboardRows.ValidateQuery(query, limit);
            var prefix = LeaderboardRows.QueryPrefix(query);
            var end = LeaderboardRows.QueryEnd(query);
            var filter = TableClient.CreateQueryFilter(
                $"PartitionKey eq {LeaderboardRows.PartitionKey} and RowKey ge {prefix} and RowKey lt {end}");
            var records = new List<LeaderboardRecord>(limit);
            var canonicalKeys = new HashSet<string>(StringComparer.Ordinal);
            string? lastKey = null;
            var pageCount = 0;
            await foreach (var page in table.QueryAsync<TableEntity>(
                filter, maxPerPage: limit, select: QueryColumns, cancellationToken: cancellationToken).AsPages())
            {
                foreach (var entity in page.Values)
                {
                    var record = Decode(entity);
                    if (!LeaderboardRules.Matches(record, query)
                        || entity.RowKey != LeaderboardRows.RankKey(record, query)
                        || lastKey is not null && StringComparer.Ordinal.Compare(lastKey, entity.RowKey) >= 0
                        || !canonicalKeys.Add(LeaderboardRows.CanonicalKey(record)))
                        throw new LeaderboardStoreUnavailableException();
                    records.Add(record);
                    lastKey = entity.RowKey;
                    if (records.Count == limit)
                        return records;
                }
                if (++pageCount >= MaximumQueryPages && page.ContinuationToken is not null)
                    throw new LeaderboardStoreUnavailableException();
            }
            return records;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new LeaderboardStoreUnavailableException();
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new LeaderboardStoreUnavailableException();
        }
    }

    private static LeaderboardRecord Decode(TableEntity entity)
    {
        if (entity.PartitionKey != LeaderboardRows.PartitionKey || string.IsNullOrEmpty(entity.RowKey)
            || string.IsNullOrEmpty(entity.ETag.ToString()) || entity.ETag == ETag.All
            || entity.Keys.Any(key => key is not ("PartitionKey" or "RowKey" or "Timestamp" or "odata.etag" or "Payload"))
            || entity.GetString("Payload") is not { Length: > 0 and <= MaximumPayloadCharacters } payload)
            throw new LeaderboardStoreUnavailableException();
        using var json = JsonDocument.Parse(payload, new JsonDocumentOptions { MaxDepth = IdentityJson.Options.MaxDepth });
        LeaderboardRows.ValidateJsonShape(json.RootElement);
        var record = json.RootElement.Deserialize<LeaderboardRecord>(IdentityJson.Options);
        if (record is null)
            throw new LeaderboardStoreUnavailableException();
        LeaderboardRules.Validate(record);
        return record;
    }

    private static bool IsMissingEntity(RequestFailedException exception) => exception.Status == 404
        && exception.ErrorCode is "ResourceNotFound" or "EntityNotFound";

    private static bool IsStorageFailure(Exception exception) =>
        exception is RequestFailedException or Azure.Identity.AuthenticationFailedException
            or JsonException or InvalidOperationException or ArgumentException or IOException;
}
