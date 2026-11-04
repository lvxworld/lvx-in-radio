# LVX News sources

Candidate sources for the LVX News station. This list is meant to become configurable later.
Terms were read and feeds were tested on 2026-11-01. This is not legal advice: have a lawyer
review the list before release.

Rules for every source: read the feed's title, summary and link, credit the source, link to the
original story in the player, reuse no images, and say that the bulletin is machine generated.

## Usable

| Source | Feed | Terms | Attribution |
|---|---|---|---|
| Wikipedia "In the news" (development example) | `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/YYYY/MM/DD`, field `news`: story, article extract and link | [CC BY-SA 4.0](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use): commercial use allowed; modified text stays under the same license | Link to each page used, a note that it was changed, and a license notice with a link |
| Global Voices | `https://globalvoices.org/feed/` | [CC BY 3.0](https://globalvoices.org/about/global-voices-attribution-policy/): commercial use and changes allowed | Author, link to the story, link to the license, and a note that it was changed |
| NASA | `https://www.nasa.gov/news-release/feed/` | [Generally not subject to US copyright](https://www.nasa.gov/nasa-brand-center/images-and-media/); no implied endorsement, and no logos | Name NASA as the source |

## Licensed, but not usable yet

| Source | Why |
|---|---|
| [Wikinews](https://en.wikinews.org/wiki/Wikinews:Copyright) | CC BY 4.0 for recent articles, but no working article feed was found |

## To check

| Source | Feed | Open question |
|---|---|---|
| NSF | `https://www.nsf.gov/rss/rss_www_news.xml` | Feed works; reuse terms not read |
| NPR | `https://feeds.npr.org/1001/rss.xml` | Feed works; terms page timed out |
| BBC | `https://feeds.bbci.co.uk/news/world/rss.xml` | Terms page could not be fetched |
| ProPublica | `https://www.propublica.org/feeds/propublica/main` | Feed works; terms not read |

## Excluded

| Source | Why |
|---|---|
| UN News | [UN terms](https://www.un.org/en/about-us/terms-of-use) allow personal non-commercial use only, with no redistribution or derivative works |
| The Conversation | [CC BY-ND](https://theconversation.com/republishing-guidelines): material cannot be edited, and systematic republication is prohibited |
