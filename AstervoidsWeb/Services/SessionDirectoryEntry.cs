namespace AstervoidsWeb.Services;

/// <summary>
/// Lightweight representation of a session stored in the directory.
/// </summary>
public record SessionDirectoryEntry(
    Guid SessionId,
    string Name,
    string RegionId,
    int MemberCount,
    int MaxMembers,
    DateTime CreatedAt);
