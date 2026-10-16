const initializeSubtleScrollbars = () => {
  document
    .querySelectorAll<HTMLElement>("[data-subtle-scrollbar]")
    .forEach((element) => {
      if (element.dataset.scrollbarReady) return;
      element.dataset.scrollbarReady = "true";

      let hideTimer = 0;
      element.addEventListener(
        "scroll",
        () => {
          element.dataset.scrolling = "true";
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => {
            delete element.dataset.scrolling;
          }, 800);
        },
        { passive: true },
      );
    });
};

export default initializeSubtleScrollbars;
