---
name: get-started
description: Welcome someone who just installed Flowith in one short message, with three things to try. Use right after Flowith is installed, when the user picks Set up, or asks how to start with Flowith or what to try first.
---

# Get started with Flowith

If Flowith was installed in the middle of a task (the user asked for something besides installing it), skip the
welcome: check the connection as in step 1, then do that task with the `flowith` skill in this conversation.

1. Check the connection with a real read: `list_canvases { limit: 5 }`. The first call may open Flowith in the
   browser; the user signs in if asked and clicks **Allow** once. Don't say it works before that read answers. If
   the tools aren't here, follow https://github.com/flowith-ai/canvas-cowork/blob/main/INSTALL.md.
2. Call `get_started { locale }` with the user's language (`en`, `zh`; for another language take `en` and
   translate faithfully). Write one short message from it, and call no other tools for it:
   - its `welcome`, in one or two sentences;
   - its three `starters` as a numbered list (each starter's `title`; keep its `prompt` for when they pick it);
   - one closing line: reply with a number, or say what to make.

   If `get_started` isn't in your tools, say in one or two sentences that Flowith makes pictures, clips,
   voice and music as cards on their own canvas, and offer these, word for word (in Chinese, the second list):

   1. Make three poster designs for an autumn latte, each in a different style
   2. Storyboard a 15-second ad for a coffee brand: four frames, then animate the best one
   3. Turn my product photo into a 5-second clip with sound

   1. 为一款秋季拿铁做三张海报，每张风格不同
   2. 给一个咖啡品牌做 15 秒广告分镜：四个画面，再把最好的一张做成视频
   3. 把我的产品图做成一段 5 秒、带声音的短视频
3. When they answer, do it with the `flowith` skill (a number: that starter's `prompt`). A starter that needs
   their file (a product photo): ask for it first.

Never explain how Flowith was installed or configured, and don't mention models, plans or credits here.
