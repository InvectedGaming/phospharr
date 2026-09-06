using System;
using MediaBrowser.Common.Plugins;

namespace Emby.Phospharr
{
    /// <summary>
    /// Registers the plugin with Emby. Everything real lives in Api/GuideApi.cs;
    /// this class exists so Emby lists us and loads the assembly's IService types.
    /// </summary>
    public class Plugin : BasePlugin
    {
        public static readonly Guid PluginId = new Guid("7e1b7c3a-5f7e-4b1e-9c2a-2f0f4b9d1a01");
        public override string Name => "Phospharr Guide";
        public override Guid Id => PluginId;
        public override string Description => "Lets Phospharr write live-TV guide data directly, without a guide refresh.";
    }
}
