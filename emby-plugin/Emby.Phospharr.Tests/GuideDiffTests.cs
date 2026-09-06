using System;
using System.Collections.Generic;
using System.Linq;
using Emby.Phospharr.Api;
using Emby.Phospharr.Guide;
using Xunit;

public class GuideDiffTests
{
    const string Ch = "m3u_" + "0000000000000000000000000000000000000000000000000000000000000000" + "_foxnews.us";
    static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 9, 6, 0, 0, 0, TimeSpan.Zero);

    static ProgramDto P(int hour, string title, string overview = null, bool live = false) =>
        new ProgramDto { Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Title = title, Description = overview, Category = "News", IsLive = live };

    static ExistingProgram E(int hour, string title, string overview = null, bool live = false, long id = 1) =>
        new ExistingProgram { InternalId = id, ExternalId = ProgramIdentity.ExternalId("foxnews.us", T0.AddHours(hour), Ch),
                              Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Name = title, Overview = overview, IsLive = live };

    static ChannelBatch Batch(params ProgramDto[] programs) =>
        new ChannelBatch { TvgId = "foxnews.us", WindowStart = T0, WindowEnd = T0.AddHours(24), Programs = programs.ToList() };

    [Fact]
    public void new_programs_are_created()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A"), P(1, "B")), new List<ExistingProgram>());
        Assert.Equal(2, d.Create.Count);
        Assert.Empty(d.Update); Assert.Empty(d.Delete);
    }

    [Fact]
    public void identical_program_is_neither_created_nor_updated()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A", "x")), new List<ExistingProgram> { E(0, "A", "x") });
        Assert.Empty(d.Create); Assert.Empty(d.Update); Assert.Empty(d.Delete);
    }

    [Fact]
    public void changed_title_or_overview_is_an_update_not_a_recreate()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A2", "x")), new List<ExistingProgram> { E(0, "A", "x") });
        Assert.Single(d.Update); Assert.Empty(d.Create); Assert.Empty(d.Delete);
        Assert.Equal("A2", d.Update[0].Incoming.Title);
    }

    [Fact]
    public void existing_program_absent_from_batch_is_deleted()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A")), new List<ExistingProgram> { E(0, "A"), E(1, "gone", id: 2) });
        Assert.Single(d.Delete); Assert.Equal(2, d.Delete[0].InternalId);
    }

    [Fact]
    public void programs_outside_the_window_are_never_deleted()
    {
        // existing at hour 30 is beyond WindowEnd (24h) — must be untouched
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A")), new List<ExistingProgram> { E(0, "A"), E(30, "later", id: 3) });
        Assert.Empty(d.Delete);
    }

    [Fact]
    public void a_program_with_a_different_start_is_a_new_identity()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(2, "A")), new List<ExistingProgram> { E(0, "A") });
        Assert.Single(d.Create); Assert.Single(d.Delete);
    }
}
