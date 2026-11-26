---
name: get-started
description: Welcome someone who just installed Flowith in one short message, with three things to try. Use right after Flowith is installed, when the user picks Set up, or asks how to start with Flowith or what to try first.
---

# Get started with Flowith

If Flowith was installed in the middle of a task (the user asked for something besides installing it), skip the
welcome: check the connection as in step 1, then do that task with the `flowith` skill in this conversation.

1. Check the connection with a real read: list the user's canvases with the Flowith tools. The first call
   may open Flowith in the browser; the user signs in if asked and clicks **Allow** once. Don't say it works
   before that read answers. If the tools aren't here, follow https://github.com/flowith-ai/canvas-cowork/blob/main/INSTALL.md.
2. Write one short message in the user's language, and call no other tools for it:
   - One or two sentences: Flowith makes pictures, clips, voice and music as cards on their own canvas,
     at the canvas's own prices, and you can open the canvas beside this chat to look at the results together.
   - These three starters as a numbered list, word for word:

     1. Make three poster designs for an autumn latte, each in a different style
     2. Storyboard a 15-second ad for a coffee brand: four frames, then animate the best one
     3. Turn my product photo into a 5-second clip with sound

     In Chinese:

     1. 为一款秋季拿铁做三张海报，每张风格不同
     2. 给一个咖啡品牌做 15 秒广告分镜：四个画面，再把最好的一张做成视频
     3. 把我的产品图做成一段 5 秒、带声音的短视频

     In another language, translate them faithfully.
   - One closing line: reply with a number, or say what to make.
3. When they answer, do it with the `flowith` skill. A starter that needs their file (a product photo): ask
   for it first.

Never explain how Flowith was installed or configured, and don't mention models, plans or credits here.
