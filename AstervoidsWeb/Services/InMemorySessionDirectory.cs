using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace AstervoidsWeb.Services;

/// <summary>
/// In-memory implementation of <see cref="ISessionDirectory"/>.
///
/// Used for local development and tests.  All changes are broadcast to subscribers
/// via bounded <see cref="Channel{T}"/> instances so test code can deterministically
/// await change events.
/// </summary>
public sealed class InMemorySessionDirectory : ISessionDirectory
{
    private readonly Dictionary<Guid, SessionDirectoryEntry> _entries = new();
    private readonly object _lock = new();
    private readonly List<ChannelWriter<SessionDirectoryChange>> _subscribers = new();

    private const int ChannelCapacity = 128;

    public Task UpsertAsync(SessionDirectoryEntry entry, CancellationToken ct = default)
    {
        List<ChannelWriter<SessionDirectoryChange>> snapshot;
        lock (_lock)
        {
            _entries[entry.SessionId] = entry;
            snapshot = new List<ChannelWriter<SessionDirectoryChange>>(_subscribers);
        }

        var change = new SessionDirectoryChange(SessionDirectoryChangeKind.Upserted, entry);
        PublishToSubscribers(snapshot, change);
        return Task.CompletedTask;
    }

    public Task RemoveAsync(Guid sessionId, CancellationToken ct = default)
    {
        List<ChannelWriter<SessionDirectoryChange>> snapshot;
        SessionDirectoryEntry? removed;
        lock (_lock)
        {
            _entries.TryGetValue(sessionId, out removed);
            _entries.Remove(sessionId);
            snapshot = new List<ChannelWriter<SessionDirectoryChange>>(_subscribers);
        }

        if (removed != null)
        {
            var change = new SessionDirectoryChange(SessionDirectoryChangeKind.Removed, removed);
            PublishToSubscribers(snapshot, change);
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<SessionDirectoryEntry>> ListAsync(CancellationToken ct = default)
    {
        IReadOnlyList<SessionDirectoryEntry> result;
        lock (_lock)
        {
            result = _entries.Values.ToList();
        }
        return Task.FromResult(result);
    }

    public async IAsyncEnumerable<SessionDirectoryChange> SubscribeAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        var channel = Channel.CreateBounded<SessionDirectoryChange>(
            new BoundedChannelOptions(ChannelCapacity)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });

        lock (_lock)
        {
            _subscribers.Add(channel.Writer);
        }

        try
        {
            await foreach (var change in channel.Reader.ReadAllAsync(ct))
            {
                yield return change;
            }
        }
        finally
        {
            lock (_lock)
            {
                _subscribers.Remove(channel.Writer);
            }
            channel.Writer.TryComplete();
        }
    }

    private static void PublishToSubscribers(
        List<ChannelWriter<SessionDirectoryChange>> subscribers,
        SessionDirectoryChange change)
    {
        foreach (var writer in subscribers)
        {
            writer.TryWrite(change);
        }
    }
}
