# Publishing LVX station songs (legacy)

The initial full-download feed below remains useful for older versions and local
song tooling. The current app keeps its downloaded songs but no longer runs this
downloader at startup. For the opt-in folder catalog, Settings and streaming, see
[LVX Live](live-radio.md).

The app reads one `manifest.json` and downloads the songs it lists. Everything lives in the assets of a single GitHub release in a separate repository, not in Git, so the repository stays small and adding songs creates no history.

## Once

```sh
gh repo create <owner>/lvx-stations --public --add-readme
gh release create songs --repo <owner>/lvx-stations --title "Lux songs" --notes "Songs for the LVX in Radio stations"
```

The repository must be public, because the app downloads without credentials.

Then set the feed address in `src/config.js`, as the default of `LVX_LUX_FEED`:

```
https://github.com/<owner>/lvx-stations/releases/download/songs/manifest.json
```

## Each time you add songs

In `lux-songs/`, after listening and deleting the `.mp3` of any song you reject:

```sh
BASE=https://github.com/<owner>/lvx-stations/releases/download/songs
npm run lux:songs -- manifest --out lux-songs --base-url "$BASE"
gh release upload songs --repo <owner>/lvx-stations --clobber lux-songs/*/*.mp3
gh release upload songs --repo <owner>/lvx-stations --clobber lux-songs/manifest.json
```

Upload the manifest last, so it never lists a song that is not there yet. The app checks the feed at each launch and downloads what is new, in the background.

To grow the stations later, raise `--count` and run `generate` again in the same folder. Keep that folder: the manifest is rebuilt from it, and a song missing from it stops being offered to new listeners.

Removing a song from the manifest does not delete it from apps that already downloaded it.

## Songs inside the app

`lux/` ships with the DMG, so the stations play on a first launch with no network. Keep two or three songs per station there, and remove the current placeholders first by deleting `lux/`:

```sh
npm run lux:songs -- import --station edm --out lux --title "Song title" lux-songs/lux-edm/<id>.mp3
```
