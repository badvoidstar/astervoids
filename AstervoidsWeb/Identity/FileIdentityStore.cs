using System.Diagnostics;
using System.Text.Json;

namespace AstervoidsWeb.Identity;

internal sealed class FileIdentityStore(string path) : IIdentityStore
{
    private readonly string _path = Path.GetFullPath(path);

    public async Task<IdentityRow?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        try
        {
            await using var fileLock = await AcquireLockAsync(cancellationToken);
            var document = await LoadAsync(cancellationToken);
            return document.Rows.TryGetValue(key, out var row)
                ? row with { StorageEtag = row.Version } : null;
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
            await using var fileLock = await AcquireLockAsync(cancellationToken);
            var document = await LoadAsync(cancellationToken);
            if (writes.Select(write => write.Row.Key).Distinct().Count() != writes.Count)
                throw new IdentityStoreUnavailableException();

            foreach (var write in writes)
            {
                var exists = document.Rows.TryGetValue(write.Row.Key, out var current);
                if (write.ExpectedStorageEtag is null ? exists
                    : !exists || current!.Version != write.ExpectedStorageEtag)
                    return false;
            }
            foreach (var write in writes)
                document.Rows[write.Row.Key] = write.Row with { StorageEtag = null };

            Validate(document);
            await SaveAsync(document, cancellationToken);
            return true;
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new IdentityStoreUnavailableException();
        }
    }

    private async Task<FileStream> AcquireLockAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var started = Stopwatch.GetTimestamp();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                // The stable lock file is never renamed/deleted: all processes
                // coordinate on it, not on the data file replaced by a commit.
                return new FileStream(_path + ".lock", FileMode.OpenOrCreate,
                    FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5))
            {
                await Task.Delay(15, cancellationToken);
            }
        }
    }

    private async Task<IdentityDocument> LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var input = new FileStream(_path, FileMode.Open, FileAccess.Read,
                FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            using var json = await JsonDocument.ParseAsync(input,
                new JsonDocumentOptions { MaxDepth = IdentityJson.Options.MaxDepth }, cancellationToken);
            if (IdentityJson.HasDuplicateProperties(json.RootElement))
                throw new IdentityStoreUnavailableException();
            var document = json.RootElement.Deserialize<IdentityDocument>(IdentityJson.Options);
            if (document is null)
                throw new IdentityStoreUnavailableException();
            Validate(document);
            return document;
        }
        catch (FileNotFoundException)
        {
            return new IdentityDocument(1, new(StringComparer.Ordinal));
        }
    }

    private async Task SaveAsync(IdentityDocument document, CancellationToken cancellationToken)
    {
        var replacement = Path.Combine(Path.GetDirectoryName(_path)!,
            $".identity-{Guid.NewGuid():N}.write");
        try
        {
            await using (var output = new FileStream(replacement, FileMode.CreateNew,
                FileAccess.Write, FileShare.None, 4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(output, document, IdentityJson.Options, cancellationToken);
                await output.FlushAsync(cancellationToken);
                output.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            // Same-directory rename replaces the whole durable transaction.
            File.Move(replacement, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(replacement))
                File.Delete(replacement);
        }
    }

    private static void Validate(IdentityDocument document)
    {
        if (document.FormatVersion != 1 || document.Rows is null)
            throw new IdentityStoreUnavailableException();

        foreach (var (key, row) in document.Rows)
        {
            if (row is null || key != row.Key)
                throw new IdentityStoreUnavailableException();
            IdentityRows.Validate(row);
            switch (row)
            {
                case PlayerIdentityRow player:
                    if (!document.Rows.TryGetValue(IdentityRows.InviteKey(player.InviteToken), out var lookup)
                        || lookup is not InviteLookupRow matchingInvite || matchingInvite.IdentityId != player.Id)
                        throw new IdentityStoreUnavailableException();
                    break;
                case InviteLookupRow invite:
                    if (!document.Rows.TryGetValue(IdentityRows.PlayerKey(invite.IdentityId), out var target)
                        || target is not PlayerIdentityRow identity
                        || IdentityRows.InviteKey(identity.InviteToken) != invite.Key)
                        throw new IdentityStoreUnavailableException();
                    break;
                case BrowserIdentityRow { IdentityId: not null } browser:
                    if (!document.Rows.TryGetValue(IdentityRows.PlayerKey(browser.IdentityId.Value), out var bound)
                        || bound is not PlayerIdentityRow { Tag: not null })
                        throw new IdentityStoreUnavailableException();
                    break;
                case IdentityOperationRow operation:
                    if (!document.Rows.TryGetValue(IdentityRows.PlayerKey(operation.BindingIdentityId), out var original)
                        || original is not PlayerIdentityRow { Tag: not null } originalIdentity)
                        throw new IdentityStoreUnavailableException();
                    if (operation.Operation == "invite")
                    {
                        var token = operation.Body.Deserialize<InviteTokenReply>(IdentityJson.Options)!.InviteToken;
                        if (!document.Rows.ContainsKey(IdentityRows.InviteKey(token)))
                            throw new IdentityStoreUnavailableException();
                    }
                    else if (operation.Body.Deserialize<BindingReply>(IdentityJson.Options)!
                        .Binding.Identity!.Tag != originalIdentity.Tag)
                        throw new IdentityStoreUnavailableException();
                    break;
            }
        }
    }

    private static bool IsStorageFailure(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or JsonException or NotSupportedException;

    private sealed record IdentityDocument(int FormatVersion, Dictionary<string, IdentityRow> Rows);
}
