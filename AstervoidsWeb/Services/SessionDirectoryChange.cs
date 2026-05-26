namespace AstervoidsWeb.Services;

/// <summary>
/// A change notification emitted by <see cref="ISessionDirectory.SubscribeAsync"/>.
/// </summary>
public sealed record SessionDirectoryChange(
    SessionDirectoryChangeKind Kind,
    SessionDirectoryEntry Entry);

/// <summary>
/// The kind of change in a <see cref="SessionDirectoryChange"/>.
/// </summary>
public enum SessionDirectoryChangeKind
{
    Upserted,
    Removed
}
