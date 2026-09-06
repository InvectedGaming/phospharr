using System;
using Emby.Phospharr.Guide;
using Xunit;

public class ProgramIdentityTests
{
    // Captured from a live Emby 4.9.5 row (USA Starz Encore Westerns, 2026-09-07 23:22 UTC).
    const string Channel = "m3u_d79194b32edab6c51a496f4131d9cdb645785c2ca85e51db130487c22664c178_starzencorewesterns.us";

    [Fact]
    public void FormatStart_matches_embys_seven_digit_utc_form()
    {
        var start = new DateTimeOffset(2026, 9, 7, 23, 22, 0, TimeSpan.Zero);
        Assert.Equal("2026-09-07T23:22:00.0000000+00:00", ProgramIdentity.FormatStart(start));
    }

    [Fact]
    public void FormatStart_normalises_a_non_utc_offset_to_utc()
    {
        var start = new DateTimeOffset(2026, 9, 7, 19, 22, 0, TimeSpan.FromHours(-4)); // same instant, EDT
        Assert.Equal("2026-09-07T23:22:00.0000000+00:00", ProgramIdentity.FormatStart(start));
    }

    [Fact]
    public void ExternalId_reproduces_the_live_row_exactly()
    {
        var start = new DateTimeOffset(2026, 9, 7, 23, 22, 0, TimeSpan.Zero);
        Assert.Equal(
            "starzencorewesterns.us_2026-09-07T23:22:00.0000000+00:00_" + Channel,
            ProgramIdentity.ExternalId("starzencorewesterns.us", start, Channel));
    }

    [Fact]
    public void TryTvgIdFromChannel_extracts_the_suffix_after_the_hash()
    {
        Assert.True(ProgramIdentity.TryTvgIdFromChannel(Channel, out var tvg));
        Assert.Equal("starzencorewesterns.us", tvg);
    }

    [Fact]
    public void TryTvgIdFromChannel_keeps_underscores_inside_the_tvgId()
    {
        Assert.True(ProgramIdentity.TryTvgIdFromChannel("m3u_" + new string('a', 64) + "_live.lofi_girl.x", out var tvg));
        Assert.Equal("live.lofi_girl.x", tvg);
    }

    [Fact]
    public void TryTvgIdFromChannel_rejects_non_m3u_ids()
    {
        Assert.False(ProgramIdentity.TryTvgIdFromChannel("hdhr_1234_5", out _));
        Assert.False(ProgramIdentity.TryTvgIdFromChannel(null, out _));
    }
}
