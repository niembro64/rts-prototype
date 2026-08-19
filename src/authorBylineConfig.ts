/**
 * Whose game this is.
 *
 * ONE definition, deliberately in a module of its own with no imports: the
 * menu column prints it as links and the map's info annex paints the same two
 * strings as the caption's closing section, and both of those sit on opposite
 * sides of the config graph. It is not a map setting — it never takes part in
 * preset identity — and it stays lowercase because a URL and an address are
 * read, not shouted.
 */
export const AUTHOR_BYLINE = {
  siteUrl: 'https://niemo.io',
  email: 'niemeyer.eric@gmail.com',
} as const;
