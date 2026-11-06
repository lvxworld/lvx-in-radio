LVX in Radio v0.1.8 adds **LVX News** (new since v0.1.5): an hourly news bulletin, read aloud on your Mac. It also fixes **Stop generating**, which could interrupt a bulletin while it was being made.

- A small **NEWS** chip beside ON AIR turns it on. Every hour the app makes a short bulletin of up to five stories, read by Qwen3-TTS (voice Ryan) over a quiet music bed that rises only between stories. Production starts about ten minutes before the hour and never interrupts a song that is composing.
- When a bulletin is ready, a "The news is ready" card asks **Listen** or **Later**. **Listen to the last bulletin** replays the latest one before the next replaces it, and **Make one now** reads the feeds again and makes a new one. The News marker on the dial plays it too.
- **Settings → News** lists the sources: BBC World and NPR can be switched off, and you can add your own RSS or Atom feeds (https), in English or Italian. Each story is read in its feed's language.
- The news voice is a separate one-time download of 4.5 GB (Apache-2.0), installed from **Settings → News**. After that it works offline, and the voice is synthetic.
- On your own stations the frequency number flips to a small Share code two seconds after you arrive, and whenever the pointer is on it.
- Other changes: the NEWS chip sits beside ON AIR, and the "Drag the dial" caption is gone.

1. Download the DMG and drag **LVX in Radio** into Applications.
2. Open it. macOS blocks it the first time because the app is not notarized: go to **System Settings → Privacy & Security → Open Anyway**, then confirm.
3. The LVX stations play at once. To make your own, accept the model terms and download the model (about 4.5 GB), or point to a folder that already holds it.
4. Optional: turn on **LVX News** from the NEWS chip (it asks you to install the voice once), and **LVX Live** to hear new songs and stations as they are published. The app asks on first launch, and you can change it any time in Settings.

Requires a Mac with Apple Silicon. Generating needs plenty of memory: it was developed on an M2 Max.
