/** A raw channel entry from a provider, before canonical matching. */
export interface RawEntry {
  rawName: string; // exactly as the provider names it, e.g. "US| ESPN HD [1080]"
  url: string;
  logoUrl?: string;
  groupTitle?: string; // provider's category, e.g. "USA SPORTS"
  tvgId?: string; // provider-supplied EPG id (tvg-id), a hint for matching
  tvgName?: string;
}
