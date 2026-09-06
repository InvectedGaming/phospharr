using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Emby.Phospharr.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Logging;

namespace Emby.Phospharr.Guide
{
    /// <summary>
    /// Writes guide programs through ILibraryManager — the same calls Emby's own
    /// Refresh Guide makes (CreateItems / UpdateItems / DeleteItem) — so caches,
    /// ancestor rows and links are Emby's responsibility, not ours.
    ///
    /// One push at a time: Emby's refresh may run concurrently and that is fine
    /// (both go through the library manager), but two of OUR pushes interleaving
    /// on the same channel would diff against stale reads.
    /// </summary>
    public class GuideWriter
    {
        private static readonly object Gate = new object();
        private readonly ILibraryManager _lib;
        private readonly ILogger _log;

        public GuideWriter(ILibraryManager lib, ILogger log) { _lib = lib; _log = log; }

        public PushGuideResult Apply(PushGuideRequest req)
        {
            var result = new PushGuideResult();
            if (req?.Channels == null || req.Channels.Count == 0) return result;
            lock (Gate)
            {
                var channels = IndexChannels();
                foreach (var batch in req.Channels)
                {
                    var r = new ChannelResult { TvgId = batch.TvgId };
                    result.Channels.Add(r);
                    try
                    {
                        if (string.IsNullOrEmpty(batch.TvgId) || !channels.TryGetValue(batch.TvgId, out var targets))
                        {
                            r.Skipped = true; r.Reason = "channel not found"; continue;
                        }
                        // The same tvg-id can exist under more than one tuner (e.g. a channel
                        // moved between phospharr tuner groups before Emby dropped the old
                        // one). Write to every match — they are the same logical channel.
                        foreach (var ch in targets) ApplyToChannel(ch, batch, r);
                    }
                    catch (Exception ex)
                    {
                        r.Skipped = true; r.Reason = ex.GetType().Name + ": " + ex.Message;
                        _log.ErrorException("Phospharr guide push failed for {0}", ex, batch.TvgId);
                    }
                }
            }
            return result;
        }

        /// <summary>tvg-id → every M3U-tuner channel item carrying it.</summary>
        private Dictionary<string, List<LiveTvChannel>> IndexChannels()
        {
            var map = new Dictionary<string, List<LiveTvChannel>>(StringComparer.Ordinal);
            var items = _lib.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { typeof(LiveTvChannel).Name } });
            foreach (var item in items)
            {
                var ch = item as LiveTvChannel;
                if (ch == null || !ProgramIdentity.TryTvgIdFromChannel(ch.ExternalId, out var tvg)) continue;
                if (!map.TryGetValue(tvg, out var list)) map[tvg] = list = new List<LiveTvChannel>();
                list.Add(ch);
            }
            return map;
        }

        private void ApplyToChannel(LiveTvChannel ch, ChannelBatch batch, ChannelResult r)
        {
            var existingItems = _lib.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { typeof(LiveTvProgram).Name },
                ParentIds = new[] { ch.InternalId },
                MinEndDate = batch.WindowStart,
                MaxStartDate = batch.WindowEnd,
            }).OfType<LiveTvProgram>().ToList();

            var byId = existingItems.ToDictionary(p => p.InternalId);
            var existing = existingItems.Select(p => new ExistingProgram
            {
                InternalId = p.InternalId, ExternalId = p.ExternalId, Start = p.StartDate, End = p.EndDate,
                Name = p.Name, Overview = p.Overview, IsLive = p.IsLive,
            }).ToList();

            var diff = GuideDiff.Compute(ch.ExternalId, batch, existing);
            var now = DateTimeOffset.UtcNow;

            var creates = diff.Create.Select(p => (BaseItem)Fill(new LiveTvProgram(), p, batch.TvgId, ch, now)).ToList();
            if (creates.Count > 0)
            {
                // Parent null + ParentId set is exactly what LiveTvManager does on refresh.
                _lib.CreateItems(creates, null, null, null, false, CancellationToken.None);
                r.Created += creates.Count;
            }

            var updates = new List<BaseItem>();
            foreach (var u in diff.Update)
            {
                var item = byId[u.Existing.InternalId];
                Fill(item, u.Incoming, batch.TvgId, ch, now);
                updates.Add(item);
            }
            if (updates.Count > 0)
            {
                _lib.UpdateItems(updates, ch, ItemUpdateType.MetadataImport, null, CancellationToken.None);
                r.Updated += updates.Count;
            }

            foreach (var d in diff.Delete)
            {
                _lib.DeleteItem(byId[d.InternalId], new DeleteOptions { DeleteFileLocation = false, DeleteFromExternalProvider = false }, false);
                r.Deleted++;
            }
        }

        private static LiveTvProgram Fill(LiveTvProgram item, ProgramDto p, string tvgId, LiveTvChannel ch, DateTimeOffset now)
        {
            var start = p.Start.ToUniversalTime();
            var end = p.End.ToUniversalTime();
            item.ExternalId = ProgramIdentity.ExternalId(tvgId, start, ch.ExternalId);
            item.ParentId = ch.InternalId;
            item.Name = p.Title ?? "";
            item.SortName = p.Title ?? "";
            item.Overview = p.Description;
            item.StartDate = start;
            item.EndDate = end;
            item.RunTimeTicks = (end - start).Ticks;
            item.IsLive = p.IsLive;
            item.IsNews = string.Equals(p.Category, "News", StringComparison.OrdinalIgnoreCase);
            item.IsSports = string.Equals(p.Category, "Sports", StringComparison.OrdinalIgnoreCase);
            item.IsMovie = string.Equals(p.Category, "Movie", StringComparison.OrdinalIgnoreCase);
            item.IsKids = string.Equals(p.Category, "Kids", StringComparison.OrdinalIgnoreCase);
            item.IsSeries = !(item.IsMovie || item.IsNews || item.IsSports);
            item.Genres = string.IsNullOrEmpty(p.Category) ? Array.Empty<string>() : new[] { p.Category };
            if (item.DateCreated == default) item.DateCreated = now;
            item.DateModified = now;
            return item;
        }
    }
}
