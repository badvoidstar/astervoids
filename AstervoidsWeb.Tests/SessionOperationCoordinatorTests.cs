using AstervoidsWeb.Services;
using FluentAssertions;

namespace AstervoidsWeb.Tests;

public class SessionOperationCoordinatorTests
{
    [Fact]
    public async Task SameSessionOperations_AreSerialized()
    {
        var coordinator = new SessionOperationCoordinator();
        var sessionId = Guid.NewGuid();
        using var first = await coordinator.EnterAsync(sessionId);

        var secondTask = coordinator.EnterAsync(sessionId);
        await Task.Delay(25);
        secondTask.IsCompleted.Should().BeFalse();

        first.Dispose();
        using var second = await secondTask.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task DifferentSessionOperations_CanRunConcurrently()
    {
        var coordinator = new SessionOperationCoordinator();
        using var first = await coordinator.EnterAsync(Guid.NewGuid());

        var secondTask = coordinator.EnterAsync(Guid.NewGuid());

        using var second = await secondTask.WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task CancelledWaiter_DoesNotStrandOrDisposeActiveGate()
    {
        var coordinator = new SessionOperationCoordinator();
        var sessionId = Guid.NewGuid();
        using var first = await coordinator.EnterAsync(sessionId);
        using var cancellation = new CancellationTokenSource();

        var waiting = coordinator.EnterAsync(sessionId, cancellation.Token);
        cancellation.Cancel();
        var act = async () => await waiting;
        await act.Should().ThrowAsync<OperationCanceledException>();

        first.Dispose();
        using var next = await coordinator
            .EnterAsync(sessionId)
            .WaitAsync(TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task LeaseDisposal_IsIdempotent()
    {
        var coordinator = new SessionOperationCoordinator();
        var sessionId = Guid.NewGuid();
        var lease = await coordinator.EnterAsync(sessionId);

        lease.Dispose();
        lease.Dispose();

        using var next = await coordinator
            .EnterAsync(sessionId)
            .WaitAsync(TimeSpan.FromSeconds(1));
    }
}
