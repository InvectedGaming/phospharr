using System.Collections.Generic;
using MediaBrowser.Model.Services;

namespace Emby.Phospharr.Api
{
    [Route("/Phospharr/Ping", "GET", Summary = "Plugin liveness + version")]
    public class PingRequest : IReturn<PingResult> { }

    public class PingResult
    {
        public string Version { get; set; }
        public string EmbyVersion { get; set; }
    }

    [Route("/Phospharr/Guide", "POST", Summary = "Upsert guide programs for channels; prunes within each channel's window")]
    [MediaBrowser.Controller.Net.Authenticated(Roles = "Admin")]
    public class PushGuideRequest : IReturn<PushGuideResult>
    {
        public List<ChannelBatch> Channels { get; set; }
    }

    public class ChannelBatch
    {
        public string TvgId { get; set; }
        public System.DateTimeOffset WindowStart { get; set; }
        public System.DateTimeOffset WindowEnd { get; set; }
        public List<ProgramDto> Programs { get; set; }
    }

    public class ProgramDto
    {
        public System.DateTimeOffset Start { get; set; }
        public System.DateTimeOffset End { get; set; }
        public string Title { get; set; }
        public string Subtitle { get; set; }
        public string Description { get; set; }
        /// <summary>Emby colour keyword: Sports / News / Movie / Kids / Series.</summary>
        public string Category { get; set; }
        public bool IsLive { get; set; }
    }

    public class ChannelResult
    {
        public string TvgId { get; set; }
        public int Created { get; set; }
        public int Updated { get; set; }
        public int Deleted { get; set; }
        public bool Skipped { get; set; }
        public string Reason { get; set; }
    }

    public class PushGuideResult
    {
        public List<ChannelResult> Channels { get; set; } = new List<ChannelResult>();
        public string Error { get; set; }
    }
}
