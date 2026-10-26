---
title: SnapDust privacy policy
---

# SnapDust privacy policy

Last updated: 26 October 2026

SnapDust is a browser extension that adds a "turn to dust" effect to your own camera image in Google Meet. This policy explains what it does with your camera, microphone and settings. In short: **everything stays on your device. SnapDust collects nothing and sends nothing anywhere.**

## Camera

When Google Meet turns on your camera, SnapDust processes each video frame on your computer to find where you are in the picture, to remember what your room looks like behind you, and to draw the effect. The processed video is handed back to Google Meet, which sends it to the call exactly as it would send your normal camera image.

SnapDust does not record, save or upload any video or image. The picture of your room it keeps for the effect exists only in your browser's memory while the Meet tab is open, and is gone when you close the tab.

## Microphone

To recognise a finger snap by its sound, SnapDust listens to the microphone that Google Meet has already opened. It analyses the sound on your computer, a few milliseconds at a time, only to decide whether a sharp click was a snap. No audio is recorded, saved or transmitted.

So that a snap works while you are muted in Meet, SnapDust keeps listening while Meet's mute is on, which can keep your computer's microphone indicator lit. If you don't want this, choose **Hand only** under "Detect by" in the SnapDust popup: it then doesn't use the microphone at all. When Google Meet closes the microphone, SnapDust stops listening too.

## Hand tracking

To recognise a snap by its movement, SnapDust looks for your hand in the camera image, on your computer, as described under Camera.

## Settings

Your SnapDust settings (for example the detection mode and sensitivity) are saved in your browser's local extension storage on this computer. They are not synced or sent anywhere. Uninstalling SnapDust deletes them.

## What SnapDust does not do

- It does not collect, store or transmit personal data, video, audio, or anything about your meetings.
- It does not use analytics, tracking, cookies, advertising or any third-party service.
- It does not download code or models at run time: everything it uses is included in the extension.
- It only runs on meet.google.com.
- No data is sold or shared, because no data leaves your device.

## Changes

If SnapDust ever changes how it handles data, this page will be updated before that version is released, and the change will be noted in the release notes on GitHub.

## Contact

Questions or concerns: open an issue at [github.com/ihemanthm/snapdust/issues](https://github.com/ihemanthm/snapdust/issues).

SnapDust is an independent project and is not affiliated with or endorsed by Google.
