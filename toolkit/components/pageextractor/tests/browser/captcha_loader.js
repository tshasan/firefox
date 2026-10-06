/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Stands in for a captcha provider's script, which inserts the widget's frame
// some time after it loads. ?frame=none never inserts one, and ?state= is
// passed on to the widget.
(() => {
  const src = new URL(document.currentScript.src);
  if (src.searchParams.get("frame") === "none") {
    return;
  }
  setTimeout(() => {
    const iframe = document.createElement("iframe");
    const frameUrl = new URL("captcha_frame.html", src);
    frameUrl.search = src.search;
    iframe.src = frameUrl.href;
    document.body.append(iframe);
  }, 500);
})();
