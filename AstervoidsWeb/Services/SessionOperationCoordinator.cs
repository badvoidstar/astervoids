namespace AstervoidsWeb.Services;

/// <summary>
/// Serializes asynchronous session operations within this process. Service-layer locks
/// still protect data; this coordinator preserves commit-and-broadcast ordering without
/// holding a monitor across asynchronous SignalR calls.
/// </summary>
public interface ISessionOperationCoordinator
{
    Task<IDisposable> EnterAsync(Guid sessionId, CancellationToken cancellationToken = default);
}

public sealed class SessionOperationCoordinator : ISessionOperationCoordinator
{
    private sealed class GateEntry
    {
        public SemaphoreSlim Semaphore { get; } = new(1, 1);
        public int References { get; set; }
    }

    private sealed class Releaser : IDisposable
    {
        private readonly SessionOperationCoordinator _owner;
        private readonly Guid _sessionId;
        private readonly GateEntry _entry;
        private int _disposed;

        public Releaser(SessionOperationCoordinator owner, Guid sessionId, GateEntry entry)
        {
            _owner = owner;
            _sessionId = sessionId;
            _entry = entry;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                _owner.Release(_sessionId, _entry);
        }
    }

    private readonly object _syncRoot = new();
    private readonly Dictionary<Guid, GateEntry> _gates = new();

    public async Task<IDisposable> EnterAsync(
        Guid sessionId,
        CancellationToken cancellationToken = default)
    {
        GateEntry entry;
        lock (_syncRoot)
        {
            if (!_gates.TryGetValue(sessionId, out entry!))
            {
                entry = new GateEntry();
                _gates.Add(sessionId, entry);
            }

            entry.References++;
        }

        try
        {
            await entry.Semaphore.WaitAsync(cancellationToken);
            return new Releaser(this, sessionId, entry);
        }
        catch
        {
            ReleaseReference(sessionId, entry);
            throw;
        }
    }

    private void Release(Guid sessionId, GateEntry entry)
    {
        entry.Semaphore.Release();
        ReleaseReference(sessionId, entry);
    }

    private void ReleaseReference(Guid sessionId, GateEntry entry)
    {
        lock (_syncRoot)
        {
            entry.References--;
            if (entry.References == 0
                && _gates.TryGetValue(sessionId, out var current)
                && ReferenceEquals(current, entry))
            {
                _gates.Remove(sessionId);
                entry.Semaphore.Dispose();
            }
        }
    }
}
