using System.Text.Json;
using Azure;
using Azure.Data.Tables;

namespace AstervoidsWeb.Identity;

internal sealed class AzureTableIdentityStore(TableClient table) : IIdentityStore
{
    public async Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        try
        {
            var response = await table.GetEntityAsync<TableEntity>(
                IdentityRows.PartitionKey, key, cancellationToken: cancellationToken);
            var entity = response.Value;
            var row = JsonSerializer.Deserialize<IdentityRow>(entity.GetString("Payload"), IdentityJson.Options);
            if (row is null || row.Key != key || entity.PartitionKey != IdentityRows.PartitionKey
                || entity.RowKey != key || string.IsNullOrEmpty(entity.ETag.ToString()))
                throw new IdentityStoreUnavailableException();
            IdentityRows.Validate(row);
            return row with { StorageEtag = entity.ETag.ToString() };
        }
        catch (RequestFailedException exception) when (IsMissingEntity(exception))
        {
            return null;
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new IdentityStoreUnavailableException();
        }
    }

    public async Task<bool> TryCommitAsync(
        IReadOnlyList<IdentityWrite> writes, CancellationToken cancellationToken)
    {
        try
        {
            var actions = writes.Select(write =>
            {
                IdentityRows.Validate(write.Row);
                var entity = new TableEntity(IdentityRows.PartitionKey, write.Row.Key)
                {
                    ["Payload"] = JsonSerializer.Serialize<IdentityRow>(write.Row, IdentityJson.Options)
                };
                return write.ExpectedStorageEtag is null
                    ? new TableTransactionAction(TableTransactionActionType.Add, entity)
                    : new TableTransactionAction(TableTransactionActionType.UpdateReplace,
                        entity, new ETag(write.ExpectedStorageEtag));
            }).ToArray();
            await table.SubmitTransactionAsync(actions, cancellationToken);
            return true;
        }
        catch (RequestFailedException exception) when (
            exception.Status is 409 or 412 || IsMissingEntity(exception))
        {
            return false;
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new IdentityStoreUnavailableException();
        }
    }

    private static bool IsMissingEntity(RequestFailedException exception) => exception.Status == 404
        && exception.ErrorCode is "ResourceNotFound" or "EntityNotFound";

    private static bool IsStorageFailure(Exception exception) =>
        exception is RequestFailedException or Azure.Identity.AuthenticationFailedException
            or JsonException or InvalidOperationException or ArgumentException or IOException;
}
