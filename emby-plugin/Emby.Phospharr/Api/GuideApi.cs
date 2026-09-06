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

        public GuideApi(ILibraryManager library, ILogManager logManager, IApplicationHost host)
        {
            _library = library;
            _log = logManager.GetLogger("Phospharr");
            _host = host;
        }

        public object Get(PingRequest request)
        {
            return new PingResult
            {
                Version = typeof(Plugin).Assembly.GetName().Version.ToString(),
                EmbyVersion = _host.ApplicationVersion.ToString(),
            };
        }
    }
}
