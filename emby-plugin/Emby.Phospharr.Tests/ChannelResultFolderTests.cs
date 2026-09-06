using System.Collections.Generic;
using Emby.Phospharr.Api;
using Emby.Phospharr.Guide;
using Xunit;

public class ChannelResultFolderTests
{
    static ChannelResult R() => new ChannelResult { TvgId = "foxnews.us" };

    [Fact]
    public void all_targets_succeeding_sums_counts_and_leaves_batch_unskipped()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome>
        {
            TargetOutcome.Ok(1, 2, 3),
            TargetOutcome.Ok(4, 0, 1),
        });

        Assert.Equal(5, r.Created);
        Assert.Equal(2, r.Updated);
        Assert.Equal(4, r.Deleted);
        Assert.False(r.Skipped);
        Assert.Null(r.Reason);
    }

    [Fact]
    public void one_target_failing_does_not_suppress_the_others_success()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome>
        {
            TargetOutcome.Failed("InvalidOperationException: boom"),
            TargetOutcome.Ok(1, 0, 0),
        });

        // The sibling's work is not discarded just because the first target blew up.
        Assert.Equal(1, r.Created);
        Assert.False(r.Skipped);
        Assert.Contains("boom", r.Reason);
    }

    [Fact]
    public void every_target_failing_marks_the_batch_skipped()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome>
        {
            TargetOutcome.Failed("Exception: a"),
            TargetOutcome.Failed("Exception: b"),
        });

        Assert.True(r.Skipped);
        Assert.Contains("a", r.Reason);
        Assert.Contains("b", r.Reason);
        Assert.Equal(0, r.Created);
    }

    [Fact]
    public void single_target_success_is_reported_normally()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome> { TargetOutcome.Ok(0, 1, 0) });

        Assert.Equal(1, r.Updated);
        Assert.False(r.Skipped);
        Assert.Null(r.Reason);
    }

    [Fact]
    public void single_target_failure_is_skipped_with_its_reason()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome> { TargetOutcome.Failed("Exception: nope") });

        Assert.True(r.Skipped);
        Assert.Equal("Exception: nope", r.Reason);
    }

    [Fact]
    public void empty_outcome_list_leaves_the_result_untouched()
    {
        var r = R();
        ChannelResultFolder.Fold(r, new List<TargetOutcome>());

        Assert.False(r.Skipped);
        Assert.Null(r.Reason);
        Assert.Equal(0, r.Created);
    }
}
