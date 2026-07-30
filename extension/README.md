# Bella Stream Control (Chrome extension)

This companion extension:

- pauses/plays the **real movie tab** when either person uses Pause/Play
- can **share only the movie video** (not the whole webpage) into Bella Stream

## Install (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `C:\Users\user1\Documents\Bella stream\extension`
5. If you already had it loaded, click **Reload** on the extension card after updates

## Share movie only (not the whole tab)

Chrome’s normal “Share tab” always includes the full page (Nunflix logo, menus, etc.).

To share **just the movie**:

1. Load/reload this extension (v1.1.0+)
2. Join a Bella Stream room
3. Open the movie site in another tab and **press play**
4. In Bella Stream click **Share movie only** (not “Share whole tab”)
5. Theater should show only the video picture

The extension searches every frame/iframe on your tabs for the biggest `<video>` and captures that stream.

## Notes

- Some sites use DRM/custom players without a normal `<video>` tag. Those may still need whole-tab share.
- Encrypted/DRM video can capture as a black frame — that is a browser limit.
- The sharer's computer must have this extension enabled.
