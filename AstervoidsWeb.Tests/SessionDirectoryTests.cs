using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

/// <summary>
/// Unit tests for <see cref="InMemorySessionDirectory"/>.
/// </summary>
public class SessionDirectoryTests
{
    private static SessionDirectoryEntry MakeEntry(
        Guid? id = null,
        string name = "Apple",
        string regionId = "local",
        int memberCount = 1,
        int maxMembers = 4)
        => new(
            id ?? Guid.NewGuid(),
            name,
            regionId,
            memberCount,
            maxMembers,
            DateTime.UtcNow);

    // ── Basic CRUD ────────────────────────────────────────────────────

    [Fact]
    public async Task UpsertAsync_AddsEntry_ListAsync_ReturnsIt()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();

        await dir.UpsertAsync(entry);

        var list = await dir.ListAsync();
        list.Should().ContainSingle(e => e.SessionId == entry.SessionId);
    }

    [Fact]
    public async Task UpsertAsync_UpdatesExistingEntry()
    {
        var dir = new InMemorySessionDirectory();
        var id = Guid.NewGuid();
        var v1 = MakeEntry(id: id, memberCount: 1);
        var v2 = MakeEntry(id: id, memberCount: 3);

        await dir.UpsertAsync(v1);
        await dir.UpsertAsync(v2);

        var list = await dir.ListAsync();
        list.Should().ContainSingle(e => e.SessionId == id && e.MemberCount == 3);
    }

    [Fact]
    public async Task RemoveAsync_RemovesEntry()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();

        await dir.UpsertAsync(entry);
        await dir.RemoveAsync(entry.SessionId);

        var list = await dir.ListAsync();
        list.Should().BeEmpty();
    }

    [Fact]
    public async Task RemoveAsync_NonExistent_IsNoOp()
    {
        var dir = new InMemorySessionDirectory();
        await dir.RemoveAsync(Guid.NewGuid()); // should not throw
    }

    // ── SubscribeAsync ────────────────────────────────────────────────

    [Fact]
    public async Task SubscribeAsync_UpsertBeforeSubscribe_NotDelivered()
    {
        // Changes that happen before the subscription starts are NOT delivered.
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();
        await dir.UpsertAsync(entry);

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var received = new List<SessionDirectoryChange>();

        // Start subscribing and collect for a brief window
        var subTask = Task.Run(async () =>
        {
            await foreach (var ch in dir.SubscribeAsync(cts.Token))
                received.Add(ch);
        });

        // Wait for subscription window to expire
        try { await subTask; } catch (OperationCanceledException) { }

        received.Should().BeEmpty("changes before subscription must not be delivered");
    }

    [Fact]
    public async Task SubscribeAsync_ReceivesUpsertedEvent()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var received = new List<SessionDirectoryChange>();
        var subscriberReady = new TaskCompletionSource();

        var subTask = Task.Run(async () =>
        {
            // Signal that the subscription loop is running
            await foreach (var ch in dir.SubscribeAsync(cts.Token))
            {
                received.Add(ch);
                cts.Cancel(); // stop after first event
            }
        });

        // Give the subscription a moment to start, then upsert
        await Task.Delay(50, CancellationToken.None);
        await dir.UpsertAsync(entry);

        try { await subTask; } catch (OperationCanceledException) { }

        received.Should().ContainSingle(c =>
            c.Kind == SessionDirectoryChangeKind.Upserted &&
            c.Entry.SessionId == entry.SessionId);
    }

    [Fact]
    public async Task SubscribeAsync_ReceivesRemovedEvent()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();
        await dir.UpsertAsync(entry);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var received = new List<SessionDirectoryChange>();

        var subTask = Task.Run(async () =>
        {
            await foreach (var ch in dir.SubscribeAsync(cts.Token))
            {
                received.Add(ch);
                if (ch.Kind == SessionDirectoryChangeKind.Removed)
                    cts.Cancel();
            }
        });

        await Task.Delay(50, CancellationToken.None);
        await dir.RemoveAsync(entry.SessionId);

        try { await subTask; } catch (OperationCanceledException) { }

        received.Should().ContainSingle(c =>
            c.Kind == SessionDirectoryChangeKind.Removed &&
            c.Entry.SessionId == entry.SessionId);
    }

    [Fact]
    public async Task SubscribeAsync_MultipleSubscribers_EachReceiveChange()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();

        using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        using var cts2 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var received1 = new List<SessionDirectoryChange>();
        var received2 = new List<SessionDirectoryChange>();

        var sub1 = Task.Run(async () =>
        {
            await foreach (var ch in dir.SubscribeAsync(cts1.Token))
            {
                received1.Add(ch);
                cts1.Cancel();
            }
        });

        var sub2 = Task.Run(async () =>
        {
            await foreach (var ch in dir.SubscribeAsync(cts2.Token))
            {
                received2.Add(ch);
                cts2.Cancel();
            }
        });

        // Allow both subscriptions to start
        await Task.Delay(50, CancellationToken.None);
        await dir.UpsertAsync(entry);

        try { await sub1; } catch (OperationCanceledException) { }
        try { await sub2; } catch (OperationCanceledException) { }

        received1.Should().ContainSingle(c => c.Entry.SessionId == entry.SessionId);
        received2.Should().ContainSingle(c => c.Entry.SessionId == entry.SessionId);
    }

    [Fact]
    public async Task SubscribeAsync_Upsert_ThenRemove_BothDeliveredInOrder()
    {
        var dir = new InMemorySessionDirectory();
        var entry = MakeEntry();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var received = new List<SessionDirectoryChange>();

        var subTask = Task.Run(async () =>
        {
            await foreach (var ch in dir.SubscribeAsync(cts.Token))
            {
                received.Add(ch);
                if (ch.Kind == SessionDirectoryChangeKind.Removed)
                {
                    cts.Cancel();
                }
            }
        });

        await Task.Delay(50, CancellationToken.None);
        await dir.UpsertAsync(entry);
        await Task.Delay(10, CancellationToken.None);
        await dir.RemoveAsync(entry.SessionId);

        try { await subTask; } catch (OperationCanceledException) { }

        received.Should().HaveCount(2);
        received[0].Kind.Should().Be(SessionDirectoryChangeKind.Upserted);
        received[1].Kind.Should().Be(SessionDirectoryChangeKind.Removed);
    }
}
