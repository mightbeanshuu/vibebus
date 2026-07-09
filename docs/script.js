const buttons = document.querySelectorAll("[data-copy]");

for (const button of buttons) {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied";
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      button.textContent = "Copied";
    }

    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 1400);
  });
}
