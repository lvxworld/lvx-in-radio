LVX in Radio v0.2.0 brings DJ conversations and confirmed song deletion to the radio.

- **Meet the LVX DJ.** Every two to four songs a DJ talks over the end of the song on air and introduces the next one by title and mood. The music ducks under the voice. Everything runs on your Mac: a small local model writes the line and the LVX News voice reads it.
- **Six DJs to choose from.** Serena, Sohee, Vivian, Ryan, Aiden and Dylan. Each station gets a default that suits its style, and you can pick another or none from the DJ chip. The LVX stations have DJs too.
- **Choose a DJ pair.** In the DJ menu, use **Talks with** to choose a co-host or **Alone**. The local writer creates a conversation, with each host speaking in their own voice. If memory is limited or writing fails, the existing single-voice fallback remains available.
- **LVX News with two hosts.** When the writer is available, Ryan and Serena alternate the stories. News facts are read from the feeds; light, recent headlines may also appear in DJ breaks.
- **Delete generated songs with confidence.** The X beside the heart shows a confirmation with the song title and approximate space to free. Confirming removes the local song and its associated DJ clips, then moves to the next available song. Cancel and Escape keep it. Included and Live songs retain “Don't play again”; removing a heart keeps the files.
- **More reliable playback.** DJ cadence can start on the first song, samples work while paused, and cancelling a conversation stops its remaining voice jobs.
- **Set it up in Settings → DJs.** Turn DJs on, choose how often they talk, and listen to each DJ before choosing. The DJ needs the News voice and a writer model (about 3 GB), downloaded once, or found in your Hugging Face cache if you already have it.
- **A single style at 100%.** A station can now use one style alone; styles at zero no longer count.

1. Download the DMG and drag **LVX in Radio** into Applications.
2. Open it. macOS blocks it the first time because the app is not notarized: go to **System Settings → Privacy & Security → Open Anyway**, then confirm.
3. The LVX stations play at once. To make your own, accept the model terms and download the model (about 4.5 GB), or point to a folder that already holds it.
4. Optional: turn on **LVX News** from the NEWS chip (it asks you to install the voice once), the **DJ** in Settings → DJs, and **LVX Live** to hear new songs and stations as they are published. The app asks about Live on first launch, and you can change any of them in Settings.

Requires a Mac with Apple Silicon. Generating needs plenty of memory: it was developed on an M2 Max.
