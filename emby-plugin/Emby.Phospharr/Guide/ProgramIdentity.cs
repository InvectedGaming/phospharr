using System;
using System.Globalization;

namespace Emby.Phospharr.Guide
{
    /// <summary>
    /// Reproduces the identity Emby's own guide refresh assigns to a program, so
    /// rows we write are the rows the nightly refresh expects to find — it then
    /// updates in place instead of duplicating or pruning them.
    ///
    ///   program ExternalId = {tvgId}_{start}_{channelExternalId}
    ///   channel ExternalId = m3u_{64 hex}_{tvgId}   (the hash is NOT reproducible
    ///                                               from the tuner URL — always look it up)
    ///
    /// Pure: no Emby types, so it is unit-testable without the SDK at runtime.
    /// </summary>
    public static class ProgramIdentity
    {
        // Emby writes DateTimeOffset with 7 fractional digits and an explicit +00:00.
        private const string StartFormat = "yyyy-MM-dd'T'HH:mm:ss.fffffff'+00:00'";
        private const string M3uPrefix = "m3u_";
        private const int HashLength = 64;

        public static string FormatStart(DateTimeOffset start)
        {
            return start.ToUniversalTime().ToString(StartFormat, CultureInfo.InvariantCulture);
        }

        public static string ExternalId(string tvgId, DateTimeOffset start, string channelExternalId)
        {
            return tvgId + "_" + FormatStart(start) + "_" + channelExternalId;
        }

        /// <summary>The tvg-id an M3U-tuner channel was created from, or false if this is not one.</summary>
        public static bool TryTvgIdFromChannel(string channelExternalId, out string tvgId)
        {
            tvgId = null;
            if (channelExternalId == null) return false;
            var minLen = M3uPrefix.Length + HashLength + 1;
            if (channelExternalId.Length <= minLen) return false;
            if (!channelExternalId.StartsWith(M3uPrefix, StringComparison.Ordinal)) return false;
            if (channelExternalId[M3uPrefix.Length + HashLength] != '_') return false;
            tvgId = channelExternalId.Substring(minLen);
            return tvgId.Length > 0;
        }
    }
}
