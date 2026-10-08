using System.Diagnostics;
using System.Text.Json;
using AstervoidsWeb.Identity;

namespace AstervoidsWeb.Leaderboards;

internal sealed class FileLeaderboardStore(string path) : ILeaderboardStore
{
    private readonly string _path = Path.GetFullPath(path);

    public async Task<LeaderboardRecord?> ReadAsync(
        Guid playerId, Guid runId, CancellationToken cancellationToken)
    {
        try
        {
            await using var fileLock = await AcquireLockAsync(cancellationToken);
            var document = await LoadAsync(cancellationToken);
            return document.Rows.TryGetValue(LeaderboardRows.CanonicalKey(playerId, runId), out var record)
                ? record with { StorageEtag = record.Version } : null;
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
            await using var fileLock = await AcquireLockAsync(cancellationToken);
            var document = await LoadAsync(cancellationToken);
            var exists = document.Rows.TryGetValue(LeaderboardRows.CanonicalKey(next), out var current);
            if (previous is null ? exists : !exists || current!.Version != previous.StorageEtag)
                return false;

            foreach (var write in writes)
            {
                var present = document.Rows.ContainsKey(write.Key);
                if (write.Kind == LeaderboardWriteKind.Add ? present : !present)
                    return false;
            }
            foreach (var write in writes)
            {
                if (write.Kind == LeaderboardWriteKind.Delete)
                    document.Rows.Remove(write.Key);
                else
                    document.Rows[write.Key] = write.Record! with { StorageEtag = null };
            }
            Validate(document);
            await SaveAsync(document, cancellationToken);
            return true;
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
            await using var fileLock = await AcquireLockAsync(cancellationToken);
            var document = await LoadAsync(cancellationToken);
            // Loading/validating the local JSON document is unavoidable. Selection
            // uses the same ordered rank-key range as Azure, never score-history filtering.
            var rows = new SortedList<string, LeaderboardRecord>(document.Rows, StringComparer.Ordinal);
            var prefix = LeaderboardRows.QueryPrefix(query);
            var end = LeaderboardRows.QueryEnd(query);
            var low = 0;
            var high = rows.Count;
            while (low < high)
            {
                var middle = low + (high - low) / 2;
                if (StringComparer.Ordinal.Compare(rows.Keys[middle], prefix) < 0)
                    low = middle + 1;
                else
                    high = middle;
            }
            var result = new List<LeaderboardRecord>(limit);
            for (var index = low; index < rows.Count && result.Count < limit
                && StringComparer.Ordinal.Compare(rows.Keys[index], end) < 0; index++)
                result.Add(rows.Values[index]);
            return result;
        }
        catch (Exception exception) when (IsStorageFailure(exception))
        {
            throw new LeaderboardStoreUnavailableException();
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
                // The stable lock inode is not the data file replaced at commit.
                return new FileStream(_path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException) when (Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5))
            {
                await Task.Delay(15, cancellationToken);
            }
        }
    }

    private async Task<LeaderboardDocument> LoadAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var input = new FileStream(_path, FileMode.Open, FileAccess.Read,
                FileShare.Read, 4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
            using var json = await JsonDocument.ParseAsync(input,
                new JsonDocumentOptions { MaxDepth = IdentityJson.Options.MaxDepth }, cancellationToken);
            if (json.RootElement.ValueKind != JsonValueKind.Object
                || IdentityJson.HasDuplicateProperties(json.RootElement)
                || !json.RootElement.TryGetProperty("rows", out var rows) || rows.ValueKind != JsonValueKind.Object)
                throw new LeaderboardStoreUnavailableException();
            foreach (var row in rows.EnumerateObject())
                LeaderboardRows.ValidateJsonShape(row.Value);
            var document = json.RootElement.Deserialize<LeaderboardDocument>(IdentityJson.Options);
            if (document is null)
                throw new LeaderboardStoreUnavailableException();
            Validate(document);
            return document;
        }
        catch (FileNotFoundException)
        {
            return new(1, new(StringComparer.Ordinal));
        }
    }

    private async Task SaveAsync(LeaderboardDocument document, CancellationToken cancellationToken)
    {
        var replacement = Path.Combine(Path.GetDirectoryName(_path)!, $".leaderboard-{Guid.NewGuid():N}.write");
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
            File.Move(replacement, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(replacement))
                File.Delete(replacement);
        }
    }

    private static void Validate(LeaderboardDocument document)
    {
        if (document.FormatVersion != 1 || document.Rows is null)
            throw new LeaderboardStoreUnavailableException();
        foreach (var (key, record) in document.Rows)
        {
            if (record is null)
                throw new LeaderboardStoreUnavailableException();
            LeaderboardRules.Validate(record);
            var canonicalKey = LeaderboardRows.CanonicalKey(record);
            var indexKeys = LeaderboardRows.IndexKeys(record);
            if (key == canonicalKey)
            {
                foreach (var index in indexKeys)
                    if (!document.Rows.TryGetValue(index, out var indexed) || indexed != record)
                        throw new LeaderboardStoreUnavailableException();
            }
            else if (!indexKeys.Contains(key, StringComparer.Ordinal)
                || !document.Rows.TryGetValue(canonicalKey, out var canonical) || canonical != record)
                throw new LeaderboardStoreUnavailableException();
        }
    }

    private static bool IsStorageFailure(Exception exception) =>
        exception is IOException or UnauthorizedAccessException or JsonException or NotSupportedException
            or ArgumentException or InvalidOperationException;

    private sealed record LeaderboardDocument(int FormatVersion, Dictionary<string, LeaderboardRecord> Rows);
}
