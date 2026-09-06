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
        private static readonly TimeSpan ChannelIndexTtl = TimeSpan.FromSeconds(60);
        // GuideApi builds a new GuideWriter per request, so the cache and its timestamp are
        // static — shared across pushes and protected by the same Gate that already serializes
        // Apply(). A phospharr sync fans one push out into ~40 chunked POSTs; without this,
        // each one re-runs a full LiveTvChannel enumeration just to resolve tvg-id -> channel.
        private static Dictionary<string, List<LiveTvChannel>> _channelIndex;
        private static DateTime _channelIndexAt = DateTime.MinValue;
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

                    if (string.IsNullOrEmpty(batch.TvgId))
                    {
                        r.Skipped = true; r.Reason = "missing TvgId"; continue;
                    }
                    if (!channels.TryGetValue(batch.TvgId, out var targets))
                    {
                        // A miss might just mean the cached index predates a channel that was
                        // added since — invalidate so the next request rebuilds it. This one
                        // still reports "not found"; the retry lands on the following push.
                        _channelIndexAt = DateTime.MinValue;
                        r.Skipped = true; r.Reason = "channel not found"; continue;
                    }

                    // The same tvg-id can exist under more than one tuner (e.g. a channel
                    // moved between phospharr tuner groups before Emby dropped the old
                    // one). Write to every match — they are the same logical channel. Each
                    // target is isolated so one channel's failure can't skip an attempt on
                    // its sibling; ChannelResultFolder combines the per-target outcomes.
                    var outcomes = new List<TargetOutcome>();
                    foreach (var ch in targets)
                    {
                        try
                        {
                            outcomes.Add(ApplyToChannel(ch, batch));
                        }
                        catch (Exception ex)
                        {
                            outcomes.Add(TargetOutcome.Failed(ex.GetType().Name + ": " + ex.Message));
                            _log.ErrorException("Phospharr guide push failed for {0}", ex, batch.TvgId);
                        }
                    }
                    ChannelResultFolder.Fold(r, outcomes);
                }
            }
            return result;
        }

        /// <summary>tvg-id → every M3U-tuner channel item carrying it. Cached under Gate for
        /// ChannelIndexTtl so a burst of chunked pushes shares one enumeration.</summary>
        private Dictionary<string, List<LiveTvChannel>> IndexChannels()
        {
            if (_channelIndex != null && DateTime.UtcNow - _channelIndexAt < ChannelIndexTtl)
                return _channelIndex;

            var map = new Dictionary<string, List<LiveTvChannel>>(StringComparer.Ordinal);
            var items = _lib.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { typeof(LiveTvChannel).Name } });
            foreach (var item in items)
            {
                var ch = item as LiveTvChannel;
                if (ch == null || !ProgramIdentity.TryTvgIdFromChannel(ch.ExternalId, out var tvg)) continue;
                if (!map.TryGetValue(tvg, out var list)) map[tvg] = list = new List<LiveTvChannel>();
                list.Add(ch);
            }
            _channelIndex = map;
            _channelIndexAt = DateTime.UtcNow;
            return _channelIndex;
        }

        private TargetOutcome ApplyToChannel(LiveTvChannel ch, ChannelBatch batch)
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
                // Fill() always writes Genres as exactly [Category] (or empty), so this round-trips.
                Category = p.Genres != null && p.Genres.Length > 0 ? p.Genres[0] : null,
            }).ToList();

            var diff = GuideDiff.Compute(ch.ExternalId, batch, existing);
            var now = DateTimeOffset.UtcNow;
            int created = 0, updated = 0, deleted = 0;

            var creates = diff.Create.Select(p => (BaseItem)Fill(new LiveTvProgram(), p, batch.TvgId, ch, now)).ToList();
            if (creates.Count > 0)
            {
                // Parent null + ParentId set is exactly what LiveTvManager does on refresh.
                _lib.CreateItems(creates, null, null, null, false, CancellationToken.None);
                created = creates.Count;
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
                updated = updates.Count;
            }

            foreach (var d in diff.Delete)
            {
                _lib.DeleteItem(byId[d.InternalId], new DeleteOptions { DeleteFileLocation = false, DeleteFromExternalProvider = false }, false);
                deleted++;
            }

            return TargetOutcome.Ok(created, updated, deleted);
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
            // p.Subtitle is intentionally not persisted here: Emby 4.9's LiveTvProgram has no
            // per-programme episode-title field (see ProgramDto.Subtitle for details).
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
