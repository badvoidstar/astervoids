using System.Security.Cryptography;

namespace AstervoidsWeb.Models;

/// <summary>
/// Represents a participant in a session.
/// </summary>
public class Member
{
    /// <summary>
    /// Globally unique identifier for this member.
    /// </summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>
    /// SignalR connection ID for this member.
    /// </summary>
    public required string ConnectionId { get; set; }

    /// <summary>
    /// The member's role within the session (Server or Client).
    /// </summary>
    public MemberRole Role { get; set; }

    /// <summary>
    /// Timestamp when the member joined the session.
    /// </summary>
    public DateTime JoinedAt { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// The session this member belongs to.
    /// </summary>
    public Guid SessionId { get; init; }

    /// <summary>
    /// Unpredictable credential proving that a reconnecting client owns this member
    /// identity. It is returned only to that member and is never broadcast.
    /// </summary>
    public string ReconnectToken { get; init; } =
        Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    /// <summary>
    /// Per-member monotonic event sequence counter for broadcasts triggered by this member.
    /// Used by clients for per-member gap detection. Accessed via Interlocked.Increment.
    /// </summary>
    public long EventSequence = 0;
}
