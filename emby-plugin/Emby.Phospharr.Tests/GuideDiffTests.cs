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

    static ProgramDto P(int hour, string title, string overview = null, bool live = false, string category = "News") =>
        new ProgramDto { Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Title = title, Description = overview, Category = category, IsLive = live };

    static ExistingProgram E(int hour, string title, string overview = null, bool live = false, long id = 1, string category = "News") =>
        new ExistingProgram { InternalId = id, ExternalId = ProgramIdentity.ExternalId("foxnews.us", T0.AddHours(hour), Ch),
                              Start = T0.AddHours(hour), End = T0.AddHours(hour + 1), Name = title, Overview = overview, IsLive = live, Category = category };

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

    [Fact]
    public void changed_category_only_is_an_update_not_a_recreate()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A", "x", category: "Sports")), new List<ExistingProgram> { E(0, "A", "x", category: "News") });
        Assert.Single(d.Update); Assert.Empty(d.Create); Assert.Empty(d.Delete);
        Assert.Equal("Sports", d.Update[0].Incoming.Category);
    }

    [Fact]
    public void null_and_empty_category_are_equivalent()
    {
        var d1 = GuideDiff.Compute(Ch, Batch(P(0, "A", "x", category: "")), new List<ExistingProgram> { E(0, "A", "x", category: null) });
        Assert.Empty(d1.Update); Assert.Empty(d1.Create); Assert.Empty(d1.Delete);

        var d2 = GuideDiff.Compute(Ch, Batch(P(0, "A", "x", category: null)), new List<ExistingProgram> { E(0, "A", "x", category: "") });
        Assert.Empty(d2.Update); Assert.Empty(d2.Create); Assert.Empty(d2.Delete);
    }

    [Fact]
    public void null_category_versus_a_real_category_is_an_update()
    {
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A", "x", category: "News")), new List<ExistingProgram> { E(0, "A", "x", category: null) });
        Assert.Single(d.Update); Assert.Empty(d.Create); Assert.Empty(d.Delete);
    }

    [Fact]
    public void duplicate_incoming_starts_in_one_batch_produce_only_one_create()
    {
        // Two programmes claiming the same channel + start (bad upstream data, or a client
        // retry that resent a row) must never both try to create the same ExternalId.
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A"), P(0, "A-dup")), new List<ExistingProgram>());
        Assert.Single(d.Create);
        Assert.Equal("A", d.Create[0].Title);
        Assert.Empty(d.Update); Assert.Empty(d.Delete);
    }

    [Fact]
    public void duplicate_incoming_start_against_an_existing_program_updates_once_and_deletes_nothing()
    {
        // The first of the duplicates should still diff normally against what Emby already
        // has; the dropped duplicate must not register as "missing" and get the row deleted.
        var d = GuideDiff.Compute(Ch, Batch(P(0, "A2"), P(0, "A2-dup")), new List<ExistingProgram> { E(0, "A") });
        Assert.Single(d.Update); Assert.Empty(d.Create); Assert.Empty(d.Delete);
        Assert.Equal("A2", d.Update[0].Incoming.Title);
    }
}
