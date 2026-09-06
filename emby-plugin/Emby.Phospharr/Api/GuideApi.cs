using System;
using System.Linq;
using System.Reflection;
using MediaBrowser.Common;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Services;

namespace Emby.Phospharr.Api
{
    /// <summary>
    /// HTTP surface. Emby discovers IService implementations in plugin assemblies
    /// automatically and injects constructor dependencies.
    /// </summary>
    public class GuideApi : IService
    {
        private readonly ILibraryManager _library;
        private readonly ILogger _log;
        private readonly IApplicationHost _host;
        private readonly Emby.Phospharr.Guide.GuideWriter _writer;

        public GuideApi(ILibraryManager library, ILogManager logManager, IApplicationHost host)
        {
            _library = library;
            _log = logManager.GetLogger("Phospharr");
            _host = host;
            _writer = new Emby.Phospharr.Guide.GuideWriter(library, _log);
        }

        public object Get(PingRequest request)
        {
            return new PingResult
            {
                Version = typeof(Plugin).Assembly.GetName().Version.ToString(),
                EmbyVersion = _host.ApplicationVersion.ToString(),
            };
        }

        public object Post(PushGuideRequest request)
        {
            // Never let an exception out: Emby's pipeline would answer 500 with no
            // per-channel detail, and phospharr needs to know WHICH channel failed.
            try
            {
                var res = _writer.Apply(request);
                var c = res.Channels;
                _log.Info("Phospharr guide push: {0} channels, +{1} ~{2} -{3}, {4} skipped",
                    c.Count, c.Sum(x => x.Created), c.Sum(x => x.Updated), c.Sum(x => x.Deleted), c.Count(x => x.Skipped));
                return res;
            }
            catch (Exception ex)
            {
                _log.ErrorException("Phospharr guide push failed", ex);
                return new PushGuideResult { Error = ex.GetType().Name + ": " + ex.Message };
            }
        }
    }
}
