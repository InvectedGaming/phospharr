using System;
using System.Collections.Generic;
using Emby.Phospharr.Api;

namespace Emby.Phospharr.Guide
{
    /// <summary>A program Emby already holds — the subset of fields the diff compares.</summary>
    public class ExistingProgram
    {
        public long InternalId { get; set; }
        public string ExternalId { get; set; }
        public DateTimeOffset Start { get; set; }
        public DateTimeOffset? End { get; set; }
        public string Name { get; set; }
        public string Overview { get; set; }
        public bool IsLive { get; set; }
    }

    public class ProgramUpdate
    {
        public ExistingProgram Existing;
        public ProgramDto Incoming;
    }

    public class DiffResult
    {
        public List<ProgramDto> Create = new List<ProgramDto>();
        public List<ProgramUpdate> Update = new List<ProgramUpdate>();
        public List<ExistingProgram> Delete = new List<ExistingProgram>();
    }

    /// <summary>
    /// Pure comparison of what Emby has against what phospharr sent. Identity is
    /// the ExternalId (so a moved start time is a new program and an old one),
    /// equality is the displayed fields. Deletion is bounded to the batch window
    /// so a push can never reach outside the range it was told about.
    /// </summary>
    public static class GuideDiff
    {
        public static DiffResult Compute(string channelExternalId, ChannelBatch batch, IReadOnlyList<ExistingProgram> existing)
        {
            var result = new DiffResult();
            var byId = new Dictionary<string, ExistingProgram>(StringComparer.Ordinal);
            foreach (var e in existing) if (e.ExternalId != null) byId[e.ExternalId] = e;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in batch.Programs ?? new List<ProgramDto>())
            {
                var id = ProgramIdentity.ExternalId(batch.TvgId, p.Start, channelExternalId);
                seen.Add(id);
                if (!byId.TryGetValue(id, out var cur)) { result.Create.Add(p); continue; }
                if (!Same(cur, p)) result.Update.Add(new ProgramUpdate { Existing = cur, Incoming = p });
            }

            foreach (var e in existing)
            {
                if (e.ExternalId == null || seen.Contains(e.ExternalId)) continue;
                // Only prune what lies inside the window this batch claims to describe.
                var end = e.End ?? e.Start;
                if (end <= batch.WindowStart || e.Start >= batch.WindowEnd) continue;
                result.Delete.Add(e);
            }
            return result;
        }

        private static bool Same(ExistingProgram e, ProgramDto p)
        {
            return string.Equals(e.Name, p.Title, StringComparison.Ordinal)
                && string.Equals(e.Overview ?? "", p.Description ?? "", StringComparison.Ordinal)
                && e.End == p.End
                && e.IsLive == p.IsLive;
        }
    }
}
