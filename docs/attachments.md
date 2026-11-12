# File attachments

Any file can be attached to a message, in a thread (Build) and in an OpenBots chat.

## What travels how

| File | How it reaches the agent |
| --- | --- |
| PNG, JPEG, WebP, GIF | Inside the message, as a picture the model looks at (as before). |
| Text and code up to 1 MB, in a thread | Inlined into the prompt (as before). |
| PDF up to 20 MB, in a thread | Inside the message, for models that read PDFs (as before). |
| Everything else: video, audio, archives, large or binary files, other image formats, and every non-picture in a bot chat | Uploaded to disk on the machine the agent runs on. The prompt names the path and the agent opens it with its own tools. |

Uploaded files are up to 4 GB each (`shared/attachments.ts`).

## Uploading

The browser sends a file in 4 MB pieces: `PUT /api/attachments/<id>?name=…&type=…&offset=…&total=…`,
body the raw bytes. A piece that fails is sent again; a piece sent twice lands where it did the first
time. Nothing on the way holds more than a piece in memory, so the same request works unchanged
through the device proxy (`/api/devices/<id>/…`) and the workspace proxy, over LAN or Tailscale.

`GET /api/attachments/<id>` returns the file, with `Range` support so a video can be scrubbed.
Audio, video, common pictures, PDFs and plain text open in the browser; anything else downloads.

## Threads

The file is stored on the machine the thread runs on: this server, or the paired device, under
`<data dir>/attachments/<id>/<name>`. The attachment keeps that `path` and the `deviceId`, and the
prompt gets one line per file:

```
[Attached file "talk.mp4" (video/mp4, 9.0 MB) is saved at /…/attachments/<id>/talk.mp4. Open it with your tools when you need it.]
```

If the thread ends up starting on another machine than the file was uploaded to (the project was
switched on the home screen, or a stash was pasted elsewhere), the composer has this server copy it
across first: `POST /api/attachments/<id>/copy { from?, to? }` (a device id, absent = this server).

## Bots

Files go to the workspace's server: `PUT /api/bots/conversations/<id>/files/<file id>`, also allowed
for a paired device's tab through the workspace routes. Once a file is whole, each bot in the
conversation gets its own copy at `~/Attachments/<first 8 of the id>/<name>` in its home folder on
that server (the same folder a container mounts), and the bot's transcript names that path. A message
carries up to 10 files next to its 4 pictures, as `files: [{ id, name, mime, size }]`. Files aren't
shared into friend chats.

A bot that wants the file on another machine copies it there itself; it is only placed on the
workspace's server.

## Not done yet

Stored files are never deleted: removing a chip, a message or a chat leaves the file on disk.
