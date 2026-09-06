using System.Collections.Generic;
using Emby.Phospharr.Api;

namespace Emby.Phospharr.Guide
{
    /// <summary>One physical channel's outcome for a single ChannelBatch: either it applied
    /// some number of creates/updates/deletes, or it failed with an error message.</summary>
    public struct TargetOutcome
    {
        public bool Success;
        public int Created;
        public int Updated;
        public int Deleted;
        public string Error;

        public static TargetOutcome Ok(int created, int updated, int deleted) =>
            new TargetOutcome { Success = true, Created = created, Updated = updated, Deleted = deleted };

        public static TargetOutcome Failed(string error) =>
            new TargetOutcome { Success = false, Error = error };
    }

    /// <summary>
    /// Pure fold of the per-physical-channel outcomes of one ChannelBatch into the single
    /// ChannelResult reported back to phospharr. A tvg-id can map to more than one physical
    /// channel item (multi-tuner); one target failing must not hide an attempt on — or the
    /// success of — its sibling. The batch is reported Skipped only when EVERY target failed;
    /// if at least one target succeeded, Skipped stays false but the failure text is still
    /// surfaced in Reason so nothing is silently lost.
    /// </summary>
    public static class ChannelResultFolder
    {
        public static void Fold(ChannelResult r, IList<TargetOutcome> outcomes)
        {
            if (r == null || outcomes == null || outcomes.Count == 0) return;

            var failures = new List<string>();
            foreach (var o in outcomes)
            {
                if (o.Success)
                {
                    r.Created += o.Created;
                    r.Updated += o.Updated;
                    r.Deleted += o.Deleted;
                }
                else
                {
                    failures.Add(o.Error);
                }
            }

            if (failures.Count > 0)
            {
                r.Reason = string.Join("; ", failures);
                if (failures.Count == outcomes.Count) r.Skipped = true;
            }
        }
    }
}
