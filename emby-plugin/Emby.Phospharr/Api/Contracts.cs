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
}
