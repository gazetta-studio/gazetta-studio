# Getting Started with Gazetta

Gazetta is a CMS that keeps your whole site in targets: folders or buckets that each hold a full copy of it. In this tutorial you create a site, edit it in the admin, publish it to a second target, and undo that publish. Everything runs on your own computer; you don't need an account anywhere.

You need Node.js 22.22.2 or later in the 22 line, 24.15 or later, or 26. Odd-numbered releases such as 23 and 25 aren't supported. Gazetta runs on macOS and Linux; on Windows, use [WSL](https://learn.microsoft.com/windows/wsl/) if you hit problems.

## 1. Create a site

```bash
npx gazetta init my-site
cd my-site
```

`init` creates the project and installs its dependencies. You get a home page with a hero and a text block, a shared header, the templates they use, and two targets: `local`, where you edit, and `staging`, a folder on your disk that plays the part of a live site.

## 2. Start the dev server

```bash
npx gazetta dev
```

Open http://localhost:3000 to see the site and http://localhost:3000/admin to edit it. Leave the server running for the rest of the tutorial.

## 3. Publish to staging

In the admin, click **Publish**, choose **staging** as the destination, then click the **Publish** button at the bottom of the panel. The first publish copies the whole site, so every page and fragment is listed. When the result shows staging, click **Done**.

## 4. Look at staging as a visitor

Open a second terminal in `my-site` and run:

```bash
npx gazetta serve staging --port 3001
```

Open http://localhost:3001. This is what a visitor would see: the pages Publish rendered into `sites/main/dist/staging/`, served without the admin. Note the hero's title, "Welcome to my-site".

## 5. Edit the home page

Back in the admin, open the home page and click its hero in the preview. The hero's form opens on the left. Change **Title** to something new and click **Save**.

The preview at http://localhost:3000 shows your new title. Reload http://localhost:3001: it still shows the old one. Saving changes `local`; staging changes only when you publish to it.

## 6. Add an image

In the same hero form, click **Pick** under **Hero image**. Drop an image file on the upload area (or click it to choose one), click the image once it appears, and click **Select**. You can type alt text for it while it uploads. Click **Save**.

The preview shows the image; http://localhost:3001 still doesn't.

## 7. Publish the change

Click **Publish**, choose **staging** and click **Publish** again. This time only what changed since the first publish is listed. Reload http://localhost:3001: the new title and the image are there.

## 8. Undo the publish

In the publish result, click **Undo** next to staging. Reload http://localhost:3001: the old title is back, and the image is gone.

The admin still shows your edit. Undo changed staging, not `local`, so your work is safe and you can publish it again whenever you like.

## What you did

- A **target** holds a whole copy of your site. You edited `local` and published to `staging`.
- **Publish** copies content from one target to another and renders it there. It works in any direction: you could also publish from staging back to `local`.
- Each target keeps its own **history**, which is what Undo used. The History panel in the admin's target menu lists every save and publish, and can restore any of them.

## Next steps

- Put the site online with the [Cloudflare deployment guide](./cloudflare.md) or the [self-hosted deployment guide](./self-hosted.md).
- Write your own templates: [Templates](./templates.md).
- Add pages, shared fragments and translations: [Pages and fragments](./pages-and-fragments.md).
- Replace a form or add a field widget: [Customize the editor](./customize-editor.md).
- Add more targets and storage: [Targets](./targets.md).
- Learn the rest of publishing, history and the command line: [Publishing](./publishing.md) and [CLI reference](./cli.md).

## If something goes wrong

- **`init` stops with an unsupported Node version.** Install one of the versions listed at the top, for example with [nvm](https://github.com/nvm-sh/nvm), and run `init` again.
- **`init` says npm install failed.** The project files are already in place. Fix what npm's error points at (often the network or a proxy), then run `npm install` inside `my-site`.
- **A port is already in use.** Another program is using port 3000 or 3001. Stop it, or pick another port with `--port`, for example `npx gazetta dev --port 3002`, and use that port in the addresses above.
- **Stopping the servers.** Press Ctrl+C in each terminal.
