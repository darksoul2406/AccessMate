import { generateImageDescription, recognizeImageText } from "../reading/image-analysis.js";

export function createImageToolsView({ listImages, getDetails, getPixels, speakResult }, page = document) {
  const fieldset = page.getElementById("image-tools");
  const status = page.getElementById("image-tools-status");
  const find = page.getElementById("find-images");
  const options = page.getElementById("image-options");
  const picker = page.getElementById("visible-image");
  const extract = page.getElementById("image-ocr");
  const describe = page.getElementById("describe-image");
  const cancel = page.getElementById("cancel-image-job");
  const output = page.getElementById("image-output");
  const result = page.getElementById("image-result");
  const read = page.getElementById("read-image-result");
  let list = null;
  let job = null;
  let available = false;

  function render() {
    fieldset.disabled = !available;
    options.hidden = !list?.items.length;
    output.hidden = !result.value;
    cancel.hidden = !job || options.hidden;
    find.disabled = picker.disabled = !!job;
    extract.disabled = describe.disabled = !!job || !picker.value;
    read.disabled = !!job || !result.value;
  }

  async function run(message, work, fallback) {
    if (!available || job) return;
    const current = new AbortController();
    job = current;
    result.value = "";
    const update = (text) => { if (job === current) status.textContent = text; };
    update(message);
    render();
    try {
      await work(current.signal, update, (text) => { if (job === current) result.value = text; });
    } catch (error) {
      update(error instanceof Error && error.message ? error.message : fallback);
    } finally {
      if (job === current) {
        job = null;
        render();
      }
    }
  }

  find.addEventListener("click", () => {
    if (job || !available) return;
    list = null;
    picker.replaceChildren();
    void run("Finding visible images…", async (signal, update) => {
      const next = await listImages();
      signal.throwIfAborted();
      list = next;
      picker.replaceChildren(...next.items.map(({ label, id }) => new page.defaultView.Option(label, id)));
      if (!next.items.length) update("No supported images are in view. Scroll to an image and try again.");
      else update(next.limited ? "Choose an image from the results. Only the first matching images are listed." : "Choose an image, then extract text or get a description.");
    }, "Could not find images. Reopen AccessMate from the toolbar and try again.");
  });

  picker.addEventListener("change", () => {
    result.value = "";
    status.textContent = "Image selected. Choose what you want to do.";
    render();
  });

  extract.addEventListener("click", () => {
    const listId = list?.listId, targetId = picker.value;
    if (!listId || !targetId) return;
    void run("Preparing image for OCR…", async (signal, update, showResult) => {
      const image = await getPixels(listId, targetId, signal);
      const { text, limited } = await recognizeImageText(image, signal, update);
      showResult(text);
      update(text ? (limited ? "Text extracted. The result was shortened." : "Text extracted. Check the result for recognition errors.") :
        "No English text was recognized. Try bringing a clearer or larger image into view.");
    }, "Could not extract text from the image.");
  });

  describe.addEventListener("click", () => {
    const listId = list?.listId;
    const selected = list?.items.find(({ id }) => id === picker.value);
    if (!selected) return;
    void run("Preparing image description…", async (signal, update, showResult) => {
      if (selected.hasDescription) {
        const details = await getDetails(listId, selected.id);
        signal.throwIfAborted();
        showResult(details.description);
        update("Description provided by the website.");
        return;
      }
      const text = await generateImageDescription(() => getPixels(listId, selected.id, signal), signal, update);
      showResult(text);
      update(text ? "AI-generated description. Details may be inaccurate." : "Chrome’s on-device AI did not return a description.");
    }, "Could not describe the image.");
  });

  cancel.addEventListener("click", () => {
    job?.abort();
    job = null;
    status.textContent = "Image processing cancelled.";
    render();
    picker.focus();
  });

  read.addEventListener("click", async () => {
    const spokenText = result.value;
    if (spokenText && !await speakResult(spokenText) && result.value === spokenText) {
      status.textContent = "Could not start speech. Check the local voice under Reading tools.";
    }
  });

  return Object.freeze({
    setAvailable(next) {
      if (next === available) return;
      available = next;
      if (!next) {
        job?.abort();
        job = null;
        list = null;
        picker.replaceChildren();
        result.value = "";
      }
      status.textContent = next ? "Find images currently visible on the page." : "Connect a website and close Reading Mode to use image assistance.";
      render();
    },
  });
}
